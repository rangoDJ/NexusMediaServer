import ffmpeg from 'fluent-ffmpeg'
import { mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { sessionStore } from './sessionStore.js'

const HLS_BASE = process.env.HLS_OUTPUT_PATH ?? '/tmp/hls'
const HW_ACCEL = (process.env.HW_ACCEL ?? '').trim() || 'cpu'

// QSV requires Intel libmfx/oneVPL which is not in Alpine's ffmpeg build.
// Redirect QSV to VAAPI which uses the same iGPU via the open-source iHD driver.
if (HW_ACCEL === 'qsv') {
  console.warn('[transcoder] HW_ACCEL=qsv is not supported in this build (Alpine ffmpeg lacks libmfx). Set HW_ACCEL=vaapi to use Intel iGPU hardware encoding via VAAPI.')
}

// Seconds to wait for the first HLS segment before declaring HW accel hung
const HW_WATCHDOG_SECS = 15

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

  const entry = { outputDir, status: 'active', process: null, watchdog: null }
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

    // Watchdog: if HW-accelerated ffmpeg produces no output after N seconds it
    // has likely hung at device init. Kill it and fall back to CPU.
    if (hwAccel !== 'cpu') {
      entry.watchdog = setTimeout(() => {
        if (!existsSync(join(outputDir, 'playlist.m3u8'))) {
          console.warn(`[transcoder] ${hwAccel} watchdog (${HW_WATCHDOG_SECS}s) — no output yet, killing and retrying with CPU`)
          try { proc.kill('SIGKILL') } catch {}
          // Clear the entry process so the error handler below is a no-op
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
      // If the watchdog already swapped to CPU, ignore this stale error event
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

export function stopSession(session_id) {
  const s = sessionStore.get(session_id)
  if (!s) return
  clearTimeout(s.watchdog)
  try { s.process?.kill('SIGKILL') } catch {}
  sessionStore.delete(session_id)
  // Best-effort cleanup of output directory
  rm(s.outputDir, { recursive: true, force: true }).catch(() => {})
}
