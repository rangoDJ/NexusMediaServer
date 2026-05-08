import ffmpeg from 'fluent-ffmpeg'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { sessionStore } from './sessionStore.js'

const HLS_BASE = process.env.HLS_OUTPUT_PATH ?? '/tmp/hls'
const HW_ACCEL = process.env.HW_ACCEL ?? 'cpu'

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
    case 'qsv':
      return {
        inputOptions: ['-hwaccel qsv', '-hwaccel_output_format qsv'],
        videoCodec:   isH265 ? 'hevc_qsv' : 'h264_qsv',
        scaleFilter:  w => `scale_qsv=${w}:-2`,
        extraOptions: [],
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

  const entry = { outputDir, status: 'active', process: null }
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

    proc.on('end', () => {
      const s = sessionStore.get(session_id)
      if (s) s.status = 'done'
    })

    proc.on('error', (err) => {
      const s = sessionStore.get(session_id)
      if (!s) return

      if (hwAccel !== 'cpu') {
        // HW acceleration failed — fall back to CPU transparently
        console.warn(`[transcoder] ${hwAccel} failed (${err.message.trim()}), retrying with CPU`)
        launchFfmpeg('cpu')
      } else {
        console.error(`[transcoder] CPU transcode failed for session ${session_id}: ${err.message.trim()}`)
        s.status = 'error'
      }
    })

    proc.run()
  }

  launchFfmpeg(HW_ACCEL)
  return outputDir
}

export function stopSession(session_id) {
  const s = sessionStore.get(session_id)
  if (!s) return
  try { s.process.kill('SIGKILL') } catch {}
  sessionStore.delete(session_id)
}
