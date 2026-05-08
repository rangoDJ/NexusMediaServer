import { useEffect, useRef, useState } from 'react'
import { MediaPlayer, MediaProvider } from '@vidstack/react'
import { defaultLayoutIcons, DefaultVideoLayout } from '@vidstack/react/player/layouts/default'
import '@vidstack/react/player/styles/default/theme.css'
import '@vidstack/react/player/styles/default/layouts/video.css'
import { api } from '../api/client.js'

export default function Player({ mediaItemId, episodeId, title }) {
  const playerRef    = useRef(null)
  const lastSaveRef  = useRef(0)
  const [src, setSrc]           = useState(null)
  const [sessionId, setSessionId] = useState(null)
  const [seekTo, setSeekTo]     = useState(0)
  const [error, setError]       = useState(null)

  const progressPath = episodeId
    ? `/media/episode/${episodeId}/progress`
    : `/media/${mediaItemId}/progress`

  // Start the stream + load saved progress
  useEffect(() => {
    let cancelled = false

    async function start() {
      try {
        let savedPos = 0
        try {
          const { data: prog } = await api.get(progressPath)
          savedPos = prog.position_secs ?? 0
        } catch {} // non-fatal

        const { data } = await api.post('/stream/start', {
          media_item_id: mediaItemId ?? undefined,
          episode_id:    episodeId ?? undefined,
          codec:         'h264',
          resolution:    '1080p',
        })
        if (cancelled) return
        setSessionId(data.session_id)
        if (savedPos > 5) setSeekTo(savedPos)
        setSrc({ src: data.playlist_url, type: 'application/x-mpegurl' })
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error ?? e.message)
      }
    }

    start()
    return () => { cancelled = true }
  }, [mediaItemId, episodeId])

  // Configure hls.js with our Authorization header when the HLS provider is attached
  function onProviderChange(provider) {
    if (provider?.type === 'hls') {
      const token = localStorage.getItem('nexus_token')
      provider.config = {
        ...provider.config,
        xhrSetup(xhr) {
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        },
      }
    }
  }

  // Seek to saved position once the player can play
  function onCanPlay() {
    if (seekTo > 0 && playerRef.current) {
      playerRef.current.currentTime = seekTo
      setSeekTo(0)
    }
  }

  // Throttled progress save
  function saveProgress(force = false) {
    const player = playerRef.current
    if (!player) return
    const pos = Math.floor(player.currentTime ?? 0)
    const dur = Math.floor(player.duration ?? 0)
    if (!dur || pos < 2) return
    const completed = pos / dur > 0.9
    api.put(progressPath, { position_secs: pos, duration_secs: dur, completed }).catch(() => {})
  }

  function onTimeUpdate() {
    const now = Date.now()
    if (now - lastSaveRef.current > 15_000) {
      lastSaveRef.current = now
      saveProgress()
    }
  }

  // Final progress save + clean up the stream session on unmount
  useEffect(() => {
    return () => {
      saveProgress(true)
      if (sessionId) api.delete(`/stream/${sessionId}`).catch(() => {})
    }
  }, [sessionId])

  if (error) {
    return (
      <div style={{ color: '#e05555', padding: 24, textAlign: 'center' }}>
        Stream error: {error}
      </div>
    )
  }

  if (!src) {
    return (
      <div style={{ color: 'var(--text-muted)', padding: 24, textAlign: 'center' }}>
        Starting stream…
      </div>
    )
  }

  return (
    <MediaPlayer
      ref={playerRef}
      title={title}
      src={src}
      autoPlay
      crossOrigin
      playsInline
      onProviderChange={onProviderChange}
      onCanPlay={onCanPlay}
      onTimeUpdate={onTimeUpdate}
      style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
    >
      <MediaProvider />
      <DefaultVideoLayout icons={defaultLayoutIcons} />
    </MediaPlayer>
  )
}
