import { useEffect, useRef, useState } from 'react'
import { MediaPlayer, MediaProvider } from '@vidstack/react'
import { defaultLayoutIcons, DefaultVideoLayout } from '@vidstack/react/player/layouts/default'
import '@vidstack/react/player/styles/default/theme.css'
import '@vidstack/react/player/styles/default/layouts/video.css'
import { api } from '../api/client.js'
import styles from './Player.module.css'

// Predefined quality presets — each one is sent to /stream/start as
// resolution + bitrate, so the transcoder produces a single HLS variant
// at that bitrate. Tweak these if you want different defaults.
const QUALITY_PRESETS = [
  { id: '4k',         label: '4K',          sub: '15 Mbps',  resolution: '4k',    bitrate: 15000 },
  { id: '1080p-high', label: '1080p High',  sub: '10 Mbps',  resolution: '1080p', bitrate: 10000 },
  { id: '1080p',      label: '1080p',       sub: '6 Mbps',   resolution: '1080p', bitrate: 6000  },
  { id: '720p',       label: '720p',        sub: '3 Mbps',   resolution: '720p',  bitrate: 3000  },
  { id: '480p',       label: '480p',        sub: '1.5 Mbps', resolution: '480p',  bitrate: 1500  },
  { id: '360p',       label: '360p',        sub: '700 Kbps', resolution: '360p',  bitrate: 700   },
]

const DEFAULT_QUALITY = '1080p'

export default function Player({ mediaItemId, episodeId, title, onEnded }) {
  const playerRef     = useRef(null)
  const lastSaveRef   = useRef(0)
  const resumeFromRef = useRef(0) // set when quality changes mid-playback
  const menuRef       = useRef(null)

  const [src, setSrc]                   = useState(null)
  const [sessionId, setSessionId]       = useState(null)
  const [seekTo, setSeekTo]             = useState(0)
  const [error, setError]               = useState(null)
  const [quality, setQuality]           = useState(() =>
    localStorage.getItem('nexus_quality') ?? DEFAULT_QUALITY
  )
  const [menuOpen, setMenuOpen]         = useState(false)

  const progressPath = episodeId
    ? `/media/episode/${episodeId}/progress`
    : `/media/${mediaItemId}/progress`

  // Start / restart the stream. Re-runs when quality changes — when that
  // happens, resumeFromRef tells us where to seek instead of the saved
  // progress (so the user resumes from where they were, not from the last
  // 15-second checkpoint).
  useEffect(() => {
    let cancelled = false

    async function start() {
      setSrc(null) // unmount the player so the old HLS chain tears down cleanly
      try {
        let savedPos = 0
        if (resumeFromRef.current > 0) {
          savedPos = resumeFromRef.current
          resumeFromRef.current = 0
        } else {
          try {
            const { data: prog } = await api.get(progressPath)
            savedPos = prog.position_secs ?? 0
          } catch {} // non-fatal
        }

        const preset = QUALITY_PRESETS.find(p => p.id === quality) ?? QUALITY_PRESETS[2]
        const { data } = await api.post('/stream/start', {
          media_item_id: mediaItemId ?? undefined,
          episode_id:    episodeId ?? undefined,
          codec:         'h264',
          resolution:    preset.resolution,
          bitrate:       preset.bitrate,
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
  }, [mediaItemId, episodeId, quality])

  // Close the quality menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    function onClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  function changeQuality(newId) {
    setMenuOpen(false)
    if (newId === quality) return
    // Capture current position so we can resume after the new stream starts
    const player = playerRef.current
    resumeFromRef.current = Math.floor(player?.currentTime ?? 0)
    localStorage.setItem('nexus_quality', newId)
    setQuality(newId)
  }

  // Attach our JWT to every hls.js segment/playlist request
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

  function onCanPlay() {
    if (seekTo > 0 && playerRef.current) {
      playerRef.current.currentTime = seekTo
      setSeekTo(0)
    }
  }

  function saveProgress() {
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

  // When playback finishes, mark complete + bubble to parent (used to
  // auto-advance to the next episode in a series).
  function handleEnded() {
    const player = playerRef.current
    const dur = Math.floor(player?.duration ?? 0)
    if (dur > 0) {
      api.put(progressPath, { position_secs: dur, duration_secs: dur, completed: true }).catch(() => {})
    }
    onEnded?.()
  }

  // Clean up the stream session when sessionId changes (quality switch) or unmount
  useEffect(() => {
    return () => {
      saveProgress()
      if (sessionId) api.delete(`/stream/${sessionId}`).catch(() => {})
    }
  }, [sessionId])

  if (error) {
    return (
      <div className={styles.errorBox}>Stream error: {error}</div>
    )
  }

  const currentPreset = QUALITY_PRESETS.find(p => p.id === quality) ?? QUALITY_PRESETS[2]

  return (
    <div className={styles.wrap}>
      {/* Quality picker — overlaid in the top-right of the player */}
      <div className={styles.qualityWrap} ref={menuRef}>
        <button
          className={styles.qualityBtn}
          onClick={() => setMenuOpen(o => !o)}
          aria-label="Change quality"
          title="Change quality"
        >
          {currentPreset.label} ▾
        </button>
        {menuOpen && (
          <div className={styles.qualityMenu}>
            <div className={styles.qualityMenuTitle}>Stream quality</div>
            {QUALITY_PRESETS.map(p => (
              <button
                key={p.id}
                className={`${styles.qualityItem} ${p.id === quality ? styles.qualityActive : ''}`}
                onClick={() => changeQuality(p.id)}
              >
                <span>{p.label}</span>
                <span className={styles.qualitySub}>{p.sub}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!src && <div className={styles.loadingBox}>Starting stream…</div>}

      {src && (
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
          onEnded={handleEnded}
          style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
        >
          <MediaProvider />
          <DefaultVideoLayout icons={defaultLayoutIcons} />
        </MediaPlayer>
      )}
    </div>
  )
}
