import axios from 'axios'
import { pickTranscoder } from './transcoderPool.js'

// Ask a transcoder node to ffprobe a file and return its technical metadata.
// Returns null if no transcoder is reachable or the file can't be probed.
export async function probeFile(db, filePath) {
  const node = await pickTranscoder(db)
  if (!node) return null

  try {
    const { data } = await axios.post(
      `${node.url}/probe`,
      { file_path: filePath },
      { headers: { 'x-transcoder-secret': process.env.TRANSCODER_SECRET }, timeout: 15_000 }
    )
    return data
  } catch {
    return null
  }
}
