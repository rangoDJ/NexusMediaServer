import ffmpeg from 'fluent-ffmpeg'
import { mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { sessionStore } from './sessionStore.js'

const HLS_BASE = process.env.HLS_OUTPUT_PATH ?? '/tmp/hls'
const HW_ACCEL = (process.env.HW_ACCEL ?? '').trim() || 'cpu'

// Seconds to wait for the first HLS segment before declaring HW accel hung
const HW_WATCHDOG_SECS = 15

// Seconds without a playlist/segment request before declaring a session
// abandoned and reaping it. Catches the case where the client crashed,
// navigated away, or DELETE got lost in flight.
const IDLE_TIMEOUT_SECS = 60

// Grace period between SIGTERM (lets ffmpeg flush + release HW contexts)
// and the SIGKILL fallback (in case ffmpeg ignores the polite signal).
const SIGKILL_GRACE_MS = 3000

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

export async function startTranscodeSession({ session_id, file_path, codec = 'h264', resolution, bitrate }) {
  const outputDir = join(HLS_BASE, session_id)
  await mkdir(outputDir, { recursive: true })

  const preset       = RESOLUTION_MAP[resolution] ?? RESOLUTION_MAP['1080p']
  const videoBitrate = bitrate ? `${bitrate}k` : preset.vb
  const isH265       = codec === 'h265'

  const entry = {
    outputDir,
    status: 'active',
    process: null,
    watchdog: null,
    lastAccessAt: Date.now(),
  }
  sessionStore.set(session_id, entry)

  function launchFfmpeg(hwAccel) {
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

    for (const [flag, value] of extraOptions) {
      proc.addOption(flag, value)
    }

    entry.process = proc

    if (hwAccel !== 'cpu') {
      entry.watchdog = setTimeout(() => {
        if (!existsSync(join(outputDir, 'playlist.m3u8'))) {
          console.warn(`[transcoder] ${hwAccel} watchdog (${HW_WATCHDOG_SECS}s) — no output yet, killing and retrying with CPU`)
          try { proc.kill('SIGKILL') } catch {}
          entry.process = null
          launchFfmpeg('cpu')
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

      if (hwAccel !== 'cpu') {
        console.warn(`[transcoder] ${hwAccel} failed (${err.message.trim()}), retrying with CPU`)
        launchFfmpeg('cpu')
      } else {
        console.error(`[transcoder] CPU transcode failed for session ${session_id}: ${err.message.trim()}`)
        s.status = 'error'
      }
    })

    proc.run()
    console.log(`[transcoder] Session ${session_id} started — codec=${videoCodec} hw=${hwAccel} file=${file_path}`)
  }

  launchFfmpeg(HW_ACCEL)
  return outputDir
}

// Mark a session as just-accessed (called from playlist + segment routes
// to keep the idle janitor from reaping a session that's actively being
// watched).
export function touchSession(session_id) {
  const s = sessionStore.get(session_id)
  if (s) s.lastAccessAt = Date.now()
}

// Polite shutdown: SIGTERM gives ffmpeg a chance to flush encoder buffers
// and release GPU contexts cleanly (important for QSV/VAAPI — SIGKILL can
// leave render units stuck at 100% for tens of seconds). SIGKILL is a
// fallback after a short grace period in case ffmpeg ignores SIGTERM.
export function stopSession(session_id, reason = 'manual') {
  const s = sessionStore.get(session_id)
  if (!s) return
  console.log(`[transcoder] Stopping session ${session_id} (${reason})`)
  clearTimeout(s.watchdog)
  sessionStore.delete(session_id)

  const proc = s.process
  if (proc) {
    try { proc.kill('SIGTERM') } catch {}
    // Backup SIGKILL — fluent-ffmpeg's kill is idempotent against an
    // already-dead process so this is safe even if SIGTERM worked.
    setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, SIGKILL_GRACE_MS)
  }

  rm(s.outputDir, { recursive: true, force: true }).catch(() => {})
}

// Periodic janitor: reaps sessions that haven't been requested by the API
// in IDLE_TIMEOUT_SECS. Handles the case where the client crashed, the page
// was force-closed, or DELETE got lost in flight — without this, sessions
// linger until the API's 4-hour expires_at and ffmpeg keeps the GPU busy.
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

// Best-effort: on process shutdown, stop all in-flight sessions so we
// don't leak ffmpegs to whatever inherits our PID namespace.
export function stopAllSessions(reason = 'shutdown') {
  for (const id of [...sessionStore.keys()]) stopSession(id, reason)
}
