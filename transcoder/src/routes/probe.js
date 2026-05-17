import ffmpeg from 'fluent-ffmpeg'
import { existsSync } from 'fs'
import { stat } from 'fs/promises'

function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err)
      resolve(metadata)
    })
  })
}

export default async function probeRoutes(app) {
  app.post('/', async (request, reply) => {
    const { file_path } = request.body
    if (!file_path) return reply.code(400).send({ error: 'file_path required' })
    if (!existsSync(file_path)) return reply.code(404).send({ error: 'File not found' })

    const [metadata, fileStat] = await Promise.all([
      probeFile(file_path),
      stat(file_path)
    ])

    const videoStream = metadata.streams.find(s => s.codec_type === 'video')
    const audioStream = metadata.streams.find(s => s.codec_type === 'audio')

    // Text-based subtitle codecs we can extract to WebVTT on the fly.
    // Image-based subs (pgs, dvd_subtitle, vobsub) require OCR — skipped for now.
    const SUB_TEXT_CODECS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'srt'])

    const subtitle_streams = metadata.streams
      .filter(s => s.codec_type === 'subtitle' && SUB_TEXT_CODECS.has(s.codec_name))
      .map(s => ({
        index:    s.index,
        codec:    s.codec_name,
        language: s.tags?.language ?? null,
        title:    s.tags?.title ?? null,
        forced:   s.disposition?.forced === 1,
        default:  s.disposition?.default === 1,
      }))

    return {
      container:    metadata.format.format_name?.split(',')[0] ?? null,
      duration_secs: metadata.format.duration ? Math.round(metadata.format.duration) : null,
      bitrate_kbps:  metadata.format.bit_rate ? Math.round(metadata.format.bit_rate / 1000) : null,
      file_size:     fileStat.size,
      video: videoStream ? {
        codec:   videoStream.codec_name,
        width:   videoStream.width,
        height:  videoStream.height,
        profile: videoStream.profile ?? null,
        level:   videoStream.level ?? null,
        fps:     videoStream.r_frame_rate ?? null,
      } : null,
      audio: audioStream ? {
        codec:    audioStream.codec_name,
        channels: audioStream.channels,
        sample_rate: audioStream.sample_rate,
      } : null,
      subtitle_streams,
    }
  })
}
