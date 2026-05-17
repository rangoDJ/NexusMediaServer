import ffmpeg from 'fluent-ffmpeg'
import { mkdir, rm } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { sessionStore } from './sessionStore.js'

const HLS_BASE = process.env.HLS_OUTPUT_PATH ?? '/tmp/hls'
const HW_ACCEL = (process.env.HW_ACCEL ?? '').trim() || 'cpu'

const HW_WATCHDOG_SECS = 15
const IDLE_TIMEOUT_SECS = 60

// How long to wait for ffmpeg to exit after SIGTERM before escalating to SIGKILL.
// VAAPI/QSV contexts need 1–5 s to drain — 8 s covers the worst case.
const SIGKILL_GRACE_MS = 8000

// After the ffmpeg process exits (or is SIGKILL'd), wait this long before
// resolving the stop promise. The i915/xe kernel driver retires the hardware
// context ring asynchronously; without this gap the next GPU operation can
// see an inconsistent context state and peg the render engine.
const GPU_CONTEXT_SETTLE_MS = 1000

if (HW_ACCEL === 'qsv') {
  console.warn('[transcoder] HW_ACCEL=qsv requires jellyfin-ffmpeg or another build with libmfx/oneVPL — Alpine system ffmpeg lacks support. Use HW_ACCEL=vaapi if that is the case.')
}

const RESOLUTION_MAP = {
  '4k':    { width: 3840, vb: '15000k' },
  '1080p': { width: 1920, vb: '8000k'  },
  '720p':  { width: 1280, vb: '4000k'  },
  '480p':  { width: 854,  vb: '1500k'  },
  '360p':  { width: 640,  vb: '800k'   },
}

// ABR variant ladder (CPU-only). The Auto preset on the client requests
// variants=true; when HW_ACCEL!='cpu' we fall back to single-variant
// because building HW ffmpeg argv with multi-scale graphs is its own
// project. Each level has a distinct bitrate so hls.js can pick.
const ABR_VARIANTS = [
  { id: 'v0', width: 854,  bitrate: '1500k' }, // 480p
  { id: 'v1', width: 1280, bitrate: '3000k' }, // 720p
  { id: 'v2', width: 1920, bitrate: '6000k' }, // 1080p
]

function buildCodecConfig(hwAccel, isH265) {
  switch (hwAccel) {
    case 'nvenc':
      return {
        inputOptions: ['-hwaccel cuda', '-hwaccel_output_format cuda'],
        videoCodec:   isH265 ? 'hevc_nvenc' : 'h264_nvenc',
        scaleFilter:  w => `scale_cuda=${w}:-2`,
        extraOptions: [['-preset', 'p4'], ['-rc', 'vbr']],
      }
    case 'vaapi': {
      const device = process.env.VAAPI_DEVICE ?? '/dev/dri/renderD128'
      return {
        inputOptions: [
          '-hwaccel vaapi',
          `-hwaccel_device ${device}`,
          '-hwaccel_output_format vaapi',
          '-extra_hw_frames 10',
        ],
        videoCodec:   isH265 ? 'hevc_vaapi' : 'h264_vaapi',
        scaleFilter:  w => `scale_vaapi=w=${w}:h=-2`,
        extraOptions: [],
      }
    }
    case 'qsv': {
      const device = process.env.VAAPI_DEVICE ?? '/dev/dri/renderD128'
      return {
        inputOptions: [
          `-init_hw_device qsv=qsv0,child_device=${device}`,
          '-hwaccel qsv',
          '-hwaccel_output_format qsv',
          '-filter_hw_device qsv0',
        ],
        videoCodec:   isH265 ? 'hevc_qsv' : 'h264_qsv',
        scaleFilter:  w => `scale_qsv=w=${w}:h=-2`,
        extraOptions: [],
      }
    }
    default: // cpu
      return {
        inputOptions: [],
        videoCodec:   isH265 ? 'libx265' : 'libx264',
        scaleFilter:  w => `scale=${w}:-2`,
        extraOptions: [['-preset', 'veryfast']],
      }
  }
}

export async function startTranscodeSession({ session_id, file_path, codec = 'h264', resolution, bitrate, variants = false }) {
  const outputDir = join(HLS_BASE, session_id)
  await mkdir(outputDir, { recursive: true })

  const useAbr = variants === true && HW_ACCEL === 'cpu'
  if (variants === true && HW_ACCEL !== 'cpu') {
    console.warn(`[transcoder] ABR requested but HW_ACCEL=${HW_ACCEL} — falling back to single-variant`)
  }

  const preset       = RESOLUTION_MAP[resolution] ?? RESOLUTION_MAP['1080p']
  const videoBitrate = bitrate ? `${bitrate}k` : preset.vb
  const isH265       = codec === 'h265'

  const entry = {
    outputDir,
    status: 'active',
    process: null,
    watchdog: null,
    lastAccessAt: Date.now(),
    abr: useAbr,
  }
  sessionStore.set(session_id, entry)

  if (useAbr) {
    launchAbrFfmpeg(session_id, file_path, outputDir, entry)
  } else {
    launchSingleFfmpeg(session_id, file_path, outputDir, entry, HW_ACCEL, isH265, preset, videoBitrate)
  }
  return outputDir
}

function launchSingleFfmpeg(session_id, file_path, outputDir, entry, hwAccel, isH265, preset, videoBitrate) {
  const { inputOptions, videoCodec, scaleFilter, extraOptions } = buildCodecConfig(hwAccel, isH265)

  const proc = ffmpeg(file_path)
  if (inputOptions.length) proc.inputOptions(inputOptions)

  proc
    .videoCodec(videoCodec)
    .audioCodec('aac')
    .videoBitrate(videoBitrate)
    .audioFrequency(48000)
    .audioChannels(2)
    .addOption('-vf', scaleFilter(preset.width))
    .addOption('-g', '48')
    .addOption('-sc_threshold', '0')
    .addOption('-hls_time', '4')
    .addOption('-hls_playlist_type', 'event')
    .addOption('-hls_segment_filename', join(outputDir, 'segment_%05d.ts'))
    .output(join(outputDir, 'playlist.m3u8'))
    .format('hls')

  for (const [flag, value] of extraOptions) proc.addOption(flag, value)

  attachLifecycle({
    session_id, proc, entry, outputDir, hwAccel, isH265,
    onHwFail: () => launchSingleFfmpeg(session_id, file_path, outputDir, entry, 'cpu', isH265,
      RESOLUTION_MAP['1080p'], videoBitrate),
    isAbr: false,
    label: videoCodec,
  })

  proc.run()
  console.log(`[transcoder] Session ${session_id} started — codec=${videoCodec} hw=${hwAccel} file=${file_path}`)
}

// CPU multi-variant ABR. Uses ffmpeg's -var_stream_map to produce one
// master.m3u8 + per-variant playlists in subdirs (v0/, v1/, v2/).
function launchAbrFfmpeg(session_id, file_path, outputDir, entry) {
  for (const v of ABR_VARIANTS) mkdirSync(join(outputDir, v.id), { recursive: true })

  const proc = ffmpeg(file_path)

  const opts = []
  // Per-variant video stream config
  ABR_VARIANTS.forEach((v, i) => {
    opts.push(
      '-map', '0:v:0',
      `-c:v:${i}`, 'libx264',
      '-preset', 'veryfast',
      `-b:v:${i}`, v.bitrate,
      `-maxrate:v:${i}`, v.bitrate,
      `-bufsize:v:${i}`, v.bitrate,
      `-filter:v:${i}`, `scale=${v.width}:-2`,
    )
  })
  // One audio mapping per variant (so var_stream_map can pair them)
  for (let i = 0; i < ABR_VARIANTS.length; i++) opts.push('-map', '0:a:0?')

  opts.push(
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '128k',
    '-g', '48',
    '-sc_threshold', '0',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', join(outputDir, 'v%v/segment_%05d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', ABR_VARIANTS.map((_, i) => `v:${i},a:${i}`).join(' '),
  )

  proc.outputOptions(opts).output(join(outputDir, 'v%v/playlist.m3u8'))

  attachLifecycle({
    session_id, proc, entry, outputDir, hwAccel: 'cpu', isH265: false,
    onHwFail: null, // CPU already
    isAbr: true,
    label: 'libx264-abr',
  })

  proc.run()
  console.log(`[transcoder] Session ${session_id} started — ABR (${ABR_VARIANTS.length} variants) file=${file_path}`)
}

function attachLifecycle({ session_id, proc, entry, outputDir, hwAccel, isAbr, onHwFail, label }) {
  entry.process = proc

  // Track real-time encoding metrics so the /metrics endpoint can serve them.
  // fluent-ffmpeg's 'progress' event gives us fps/frames/bitrate/timemark;
  // 'stderr' is needed for speed= which ffmpeg prints but fluent-ffmpeg doesn't parse.
  proc.on('progress', progress => {
    const s = sessionStore.get(session_id)
    if (!s) return
    s.metrics = {
      fps:        progress.currentFps  ?? null,
      frames:     progress.frames      ?? null,
      bitrate:    progress.currentKbps ?? null,
      timemark:   progress.timemark    ?? null,
      speed:      s.metrics?.speed     ?? null, // preserved from stderr handler below
      updated_at: Date.now(),
    }
  })

  proc.on('stderr', line => {
    const m = /speed=\s*([\d.]+)x/.exec(line)
    if (!m) return
    const s = sessionStore.get(session_id)
    if (!s) return
    if (!s.metrics) s.metrics = {}
    s.metrics.speed      = parseFloat(m[1])
    s.metrics.updated_at = Date.now()
  })

  if (hwAccel !== 'cpu') {
    const sentinel = isAbr ? join(outputDir, 'master.m3u8') : join(outputDir, 'playlist.m3u8')
    entry.watchdog = setTimeout(() => {
      if (!existsSync(sentinel)) {
        console.warn(`[transcoder] ${hwAccel} watchdog (${HW_WATCHDOG_SECS}s) — no output yet, killing and retrying with CPU`)
        try { proc.kill('SIGKILL') } catch {}
        entry.process = null
        if (onHwFail) onHwFail()
      }
    }, HW_WATCHDOG_SECS * 1000)
  }

  proc.on('end', () => {
    clearTimeout(entry.watchdog)
    const s = sessionStore.get(session_id)
    if (s) s.status = 'done'
  })

  proc.on('error', (err) => {
    clearTimeout(entry.watchdog)
    if (entry.process !== proc) return
    const s = sessionStore.get(session_id)
    if (!s) return
    if (hwAccel !== 'cpu' && onHwFail) {
      console.warn(`[transcoder] ${hwAccel} failed (${err.message.trim()}), retrying with CPU`)
      onHwFail()
    } else {
      console.error(`[transcoder] ${label} transcode failed for session ${session_id}: ${err.message.trim()}`)
      s.status = 'error'
    }
  })
}

export function touchSession(session_id) {
  const s = sessionStore.get(session_id)
  if (s) s.lastAccessAt = Date.now()
}

// ─── Core stop primitive ─────────────────────────────────────────────────────
//
// Sends SIGTERM to the ffmpeg process and AWAITS its exit before returning.
// This is the critical difference from the old fire-and-forget approach:
// returning only after the process has fully exited means the caller can be
// sure the VAAPI/QSV hardware context has been released by the i915 driver
// before anything else runs (including process.exit in the shutdown handler).
//
// Escalation ladder:
//   t=0          SIGTERM sent
//   t=SIGKILL_GRACE_MS   ffmpeg still alive → SIGKILL
//   t+GPU_CONTEXT_SETTLE_MS  wait for i915 to retire the hw context ring
//   → resolve
//
// The 'error' event fires for SIGTERM kills too (fluent-ffmpeg treats any
// non-zero exit as an error), so both 'end' and 'error' are treated as done.
async function drainProcess(session_id, proc) {
  if (!proc) return

  await new Promise(resolve => {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      // Brief settle gap so the kernel driver retires the GPU context ring
      setTimeout(resolve, GPU_CONTEXT_SETTLE_MS)
    }

    proc.once('end',   settle)
    proc.once('error', settle)

    try {
      proc.kill('SIGTERM')
    } catch {
      settle()
      return
    }

    const killTimer = setTimeout(() => {
      console.warn(
        `[transcoder] ${session_id}: ffmpeg still running ${SIGKILL_GRACE_MS}ms after SIGTERM — ` +
        `escalating to SIGKILL (GPU context may not release cleanly)`
      )
      try { proc.kill('SIGKILL') } catch {}
      // Give the i915 driver the settle window even after SIGKILL
      setTimeout(settle, GPU_CONTEXT_SETTLE_MS)
    }, SIGKILL_GRACE_MS)
  })
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Fire-and-forget stop — used by the idle janitor and client DELETE requests.
// Removes the session from the store immediately (so new sessions don't see it)
// and kicks off the drain in the background.
export function stopSession(session_id, reason = 'manual') {
  const s = sessionStore.get(session_id)
  if (!s) return
  console.log(`[transcoder] Stopping session ${session_id} (${reason})`)
  clearTimeout(s.watchdog)
  sessionStore.delete(session_id)
  drainProcess(session_id, s.process).catch(() => {})
  rm(s.outputDir, { recursive: true, force: true }).catch(() => {})
}

// Graceful stop that RETURNS A PROMISE — used only by the shutdown handler so
// the Node.js process doesn't exit before ffmpeg has finished releasing the GPU.
async function stopSessionGracefully(session_id, s, reason) {
  console.log(`[transcoder] Graceful stop: session ${session_id} (${reason})`)
  clearTimeout(s.watchdog)
  sessionStore.delete(session_id)
  await drainProcess(session_id, s.process)
  await rm(s.outputDir, { recursive: true, force: true }).catch(() => {})
}

let janitorHandle = null
export function startIdleJanitor() {
  if (janitorHandle) return
  janitorHandle = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessionStore.entries()) {
      if (now - s.lastAccessAt > IDLE_TIMEOUT_SECS * 1000) {
        stopSession(id, `idle for ${IDLE_TIMEOUT_SECS}s`)
      }
    }
  }, 10_000)
}

export function stopIdleJanitor() {
  clearInterval(janitorHandle)
  janitorHandle = null
}

// Gracefully stop every active session in parallel and wait for all of them.
// Called by the SIGTERM handler so we're guaranteed every ffmpeg has exited
// (and every VAAPI/QSV context has been released) before process.exit() runs.
export async function stopAllSessionsGracefully(reason = 'shutdown') {
  const entries = [...sessionStore.entries()]
  if (!entries.length) return
  console.log(`[transcoder] Gracefully stopping ${entries.length} session(s) (${reason})`)
  await Promise.all(entries.map(([id, s]) => stopSessionGracefully(id, s, reason)))
  console.log(`[transcoder] All sessions stopped — GPU contexts released`)
}
