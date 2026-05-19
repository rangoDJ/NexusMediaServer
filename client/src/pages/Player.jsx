import { useEffect, useRef, useState } from 'react'
import { MediaPlayer, MediaProvider, Track } from '@vidstack/react'
import { defaultLayoutIcons, DefaultVideoLayout } from '@vidstack/react/player/layouts/default'
import '@vidstack/react/player/styles/default/theme.css'
import '@vidstack/react/player/styles/default/layouts/video.css'
import { api } from '../api/client.js'
import styles from './Player.module.css'

// Bitrate presets used when the file requires transcoding (or when the user
// explicitly forces a quality cap). Direct play ignores these.
const QUALITY_PRESETS = [
  { id: 'auto',       label: 'Auto',        sub: 'direct play if compatible' },
  { id: '4k',         label: '4K',          sub: '15 Mbps',  resolution: '4k',    bitrate: 15000 },
  { id: '1080p-high', label: '1080p High',  sub: '10 Mbps',  resolution: '1080p', bitrate: 10000 },
  { id: '1080p',      label: '1080p',       sub: '6 Mbps',   resolution: '1080p', bitrate: 6000  },
  { id: '720p',       label: '720p',        sub: '3 Mbps',   resolution: '720p',  bitrate: 3000  },
  { id: '480p',       label: '480p',        sub: '1.5 Mbps', resolution: '480p',  bitrate: 1500  },
  { id: '360p',       label: '360p',        sub: '700 Kbps', resolution: '360p',  bitrate: 700   },
]

const DEFAULT_QUALITY = 'auto'

// MIME for vidstack's `src.type` when direct-playing
const MIME_BY_CONTAINER = {
  mp4:  'video/mp4',
  m4v:  'video/mp4',
  webm: 'video/webm',
  mov:  'video/quicktime',
  mkv:  'video/x-matroska',
}

function formatBitrate(kbps) {
  if (!kbps) return '—'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} Kbps`
}

export default function Player({ mediaItemId, episodeId, title, onEnded }) {
  const playerRef     = useRef(null)
  const lastSaveRef   = useRef(0)
  const resumeFromRef = useRef(0)
  const menuRef       = useRef(null)

  const [src, setSrc]                 = useState(null)
  const [sessionId, setSessionId]     = useState(null) // null => direct play (no transcode)
  const [seekTo, setSeekTo]           = useState(0)
  const [error, setError]             = useState(null)
  const [mode, setMode]               = useState(null) // 'direct' | 'abr' | 'transcode'
  const [tracks, setTracks]           = useState([])   // subtitle tracks for vidstack
  const [playbackInfo, setPlaybackInfo] = useState(null) // file codec/resolution info
  const [quality, setQuality]         = useState(() =>
    localStorage.getItem('nexus_quality') ?? DEFAULT_QUALITY
  )
  const [menuOpen, setMenuOpen]       = useState(false)
  const [retryTrigger, setRetryTrigger] = useState(0)
  const [showStats, setShowStats]     = useState(false)
  const [statsData, setStatsData]     = useState({})   // buffer + transcoder metrics

  const progressPath = episodeId
    ? `/media/episode/${episodeId}/progress`
    : `/media/${mediaItemId}/progress`

  // Start / restart playback.
  // - quality === 'auto'  → prefer direct play, fall back to transcoded HLS
  // - quality === preset  → force transcode at that bitrate
  useEffect(() => {
    let cancelled = false

    async function start() {
      setSrc(null)
      setError(null)  // clear any previous player error before restarting
      try {
        // Resume position: in-stream switch overrides saved progress
        let savedPos = 0
        if (resumeFromRef.current > 0) {
          savedPos = resumeFromRef.current
          resumeFromRef.current = 0
        } else {
          try {
            const { data: prog } = await api.get(progressPath)
            savedPos = prog.position_secs ?? 0
          } catch {}
        }

        const preset = QUALITY_PRESETS.find(p => p.id === quality) ?? QUALITY_PRESETS[0]

        // Always fetch playback-info — gives us subtitle tracks regardless of
        // direct vs transcode choice.
        let pi = null
        try { pi = await fetchPlaybackInfo() } catch {}

        if (!cancelled) {
          setTracks(buildTrackList(pi))
          setPlaybackInfo(pi)
        }

        // Try direct play first when on Auto
        if (preset.id === 'auto' && pi?.playback?.direct_play && pi?.playback?.direct_play_url) {
          const token = localStorage.getItem('nexus_token')
          const url   = `${pi.playback.direct_play_url}&token=${encodeURIComponent(token)}`
          const type  = MIME_BY_CONTAINER[pi.file?.container?.toLowerCase()] ?? 'video/mp4'
          if (cancelled) return
          setMode('direct')
          setSessionId(null)
          if (savedPos > 5) setSeekTo(savedPos)
          setSrc({ src: url, type })
          return
        }

        // Transcode path. Auto → request ABR so hls.js can switch variants
        // based on measured bandwidth. Manual quality → single variant at
        // the chosen bitrate.
        const params = preset.id === 'auto'
          ? { codec: 'h264', resolution: '1080p', variants: true }
          : { codec: 'h264', resolution: preset.resolution, bitrate: preset.bitrate }

        const { data } = await api.post('/stream/start', {
          media_item_id: mediaItemId ?? undefined,
          episode_id:    episodeId ?? undefined,
          ...params,
        })
        if (cancelled) return
        setMode(data.abr ? 'abr' : 'transcode')
        setSessionId(data.session_id)
        if (savedPos > 5) setSeekTo(savedPos)
        // Embed the JWT as ?token= so the very first manifest request is
        // authenticated. hls.js races the xhrSetup callback on its initial
        // fetch, causing a 401 if only the Authorization header approach is used.
        const hlsToken = localStorage.getItem('nexus_token')
        const hlsUrl   = `${data.playlist_url}?token=${encodeURIComponent(hlsToken)}`
        setSrc({ src: hlsUrl, type: 'application/x-mpegurl' })
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error ?? e.message)
      }
    }

    start()
    return () => { cancelled = true }
  }, [mediaItemId, episodeId, quality, retryTrigger])

  async function fetchPlaybackInfo() {
    const id = mediaItemId ?? episodeId
    const params = episodeId ? { episode_id: episodeId } : {}
    const { data } = await api.get(`/media/${id}/playback-info`, { params })
    return data
  }

  // Map server subtitle_tracks into vidstack <Track> props. Token goes into
  // the URL since <track> elements can't add Authorization headers.
  function buildTrackList(pi) {
    if (!pi?.subtitle_tracks?.length) return []
    const token = localStorage.getItem('nexus_token')
    return pi.subtitle_tracks.map(t => ({
      src:      `${t.url}?token=${encodeURIComponent(token)}`,
      kind:     'subtitles',
      language: t.language ?? 'und',
      label:    [t.title, t.language?.toUpperCase(), t.forced ? '(forced)' : '']
                  .filter(Boolean).join(' · ') || `Track ${t.stream_index}`,
      default:  !!t.default,
    }))
  }

  // Close quality menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    function onClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  // Poll buffer level and (for active transcode sessions) encoding metrics
  // every 2s while the stats overlay is open.
  useEffect(() => {
    if (!showStats) { setStatsData({}); return }

    let cancelled = false

    function readBuffer() {
      const player = playerRef.current
      if (!player) return null
      const ct = player.currentTime ?? 0
      const buf = player.buffered
      if (!buf || buf.length === 0) return null
      // Find the buffered range that contains (or starts at/before) current time
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf.start(i) <= ct + 0.1) {
          return Math.max(0, buf.end(i) - ct)
        }
      }
      return null
    }

    async function tick() {
      if (cancelled) return
      const bufferAhead = readBuffer()
      setStatsData(prev => ({ ...prev, bufferAhead }))

      if (sessionId) {
        try {
          const { data } = await api.get(`/stream/${sessionId}/metrics`)
          if (!cancelled) setStatsData(prev => ({ ...prev, ...data }))
        } catch {
          // transcoder metrics are best-effort; don't surface errors
        }
      }
    }

    tick()
    const id = setInterval(tick, 2000)
    return () => { cancelled = true; clearInterval(id) }
  }, [showStats, sessionId])

  function changeQuality(newId) {
    setMenuOpen(false)
    if (newId === quality) return
    const player = playerRef.current
    resumeFromRef.current = Math.floor(player?.currentTime ?? 0)
    localStorage.setItem('nexus_quality', newId)
    setQuality(newId)
  }

  // Attach JWT to hls.js segment/playlist requests (transcode mode only).
  // Also extend the manifest / level loading timeout: our API holds the playlist
  // request open for up to 20s while ffmpeg starts producing segments. The
  // hls.js default of 10s fires before the server responds, causing a spurious
  // "network timeout" error. 30s gives comfortable headroom.
  function onProviderChange(provider) {
    if (provider?.type === 'hls') {
      const token = localStorage.getItem('nexus_token')
      provider.config = {
        ...provider.config,
        manifestLoadingTimeOut:  30_000,
        manifestLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut:     25_000,
        fragLoadingTimeOut:      20_000,
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

  // Surface hls.js / native player errors as a visible message instead of
  // leaving the user with an infinite spinning circle.
  // Vidstack puts the message directly on the event object (not under detail).
  // We probe multiple paths in order to handle the different shapes hls.js,
  // HTMLMediaElement, and network errors produce.
  function handlePlayerError(event) {
    console.error('[Player] error event:', event, 'detail:', event?.detail)
    const detail = event?.detail
    const msg =
      event?.message ??
      detail?.message ??
      detail?.error?.message ??
      detail?.nativeEvent?.message ??
      (typeof detail === 'string' ? detail : null) ??
      'stream failed to load'
    setError(msg)
  }

  function handleEnded() {
    const player = playerRef.current
    const dur = Math.floor(player?.duration ?? 0)
    if (dur > 0) {
      api.put(progressPath, { position_secs: dur, duration_secs: dur, completed: true }).catch(() => {})
    }
    onEnded?.()
  }

  // Tear down the transcoder session when sessionId changes (quality switch)
  // or unmount. Direct-play mode has no session so this is a no-op then.
  useEffect(() => {
    return () => {
      saveProgress()
      if (sessionId) api.delete(`/stream/${sessionId}`).catch(() => {})
    }
  }, [sessionId])

  if (error) {
    return (
      <div className={styles.errorBox}>
        <div>Stream error: {error}</div>
        <button
          className={styles.retryBtn}
          onClick={() => { setError(null); setRetryTrigger(n => n + 1) }}
        >
          ↺ Retry
        </button>
      </div>
    )
  }

  const currentPreset = QUALITY_PRESETS.find(p => p.id === quality) ?? QUALITY_PRESETS[0]
  const modeBadge =
    mode === 'direct'    ? 'Direct'    :
    mode === 'abr'       ? 'ABR'       :
    mode === 'transcode' ? 'Transcode' : null

  return (
    <div className={styles.wrap}>
      {/* Top-right controls: stats toggle + quality picker */}
      <div className={styles.topControls}>
        {/* Stats toggle */}
        <button
          className={`${styles.statsBtn} ${showStats ? styles.statsBtnActive : ''}`}
          onClick={() => setShowStats(s => !s)}
          aria-label="Toggle playback stats"
          title="Playback stats"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <rect x="1"   y="7" width="3" height="6" rx="0.5" fill="currentColor"/>
            <rect x="5.5" y="4" width="3" height="9" rx="0.5" fill="currentColor"/>
            <rect x="10"  y="1" width="3" height="12" rx="0.5" fill="currentColor"/>
          </svg>
        </button>

        {/* Quality picker */}
        <div className={styles.qualityWrap} ref={menuRef}>
          <button
            className={styles.qualityBtn}
            onClick={() => setMenuOpen(o => !o)}
            aria-label="Change quality"
          >
            {currentPreset.label}
            {modeBadge && <span className={styles.modePill}>{modeBadge}</span>}
            <span style={{ marginLeft: 4 }}>▾</span>
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
      </div>

      {/* Stats overlay */}
      {showStats && src && (
        <div className={styles.statsOverlay}>
          <div className={styles.statsTitle}>Playback Stats</div>
          <dl className={styles.statsGrid}>
            <dt>Mode</dt>
            <dd>
              {mode === 'direct'    && 'Direct Play'}
              {mode === 'abr'       && 'ABR Transcode'}
              {mode === 'transcode' && 'Transcode'}
              {!mode                && '—'}
            </dd>

            {playbackInfo?.file?.video_codec && (
              <>
                <dt>Video</dt>
                <dd>
                  {playbackInfo.file.video_codec.toUpperCase()}
                  {playbackInfo.file.width && playbackInfo.file.height
                    ? ` · ${playbackInfo.file.width}×${playbackInfo.file.height}`
                    : ''}
                </dd>
              </>
            )}

            {playbackInfo?.file?.audio_codec && (
              <>
                <dt>Audio</dt>
                <dd>{playbackInfo.file.audio_codec.toUpperCase()}</dd>
              </>
            )}

            {playbackInfo?.file?.bitrate_kbps > 0 && (
              <>
                <dt>Bitrate</dt>
                <dd>{formatBitrate(playbackInfo.file.bitrate_kbps)}</dd>
              </>
            )}

            <dt>Buffer</dt>
            <dd>{statsData.bufferAhead != null ? `${statsData.bufferAhead.toFixed(1)} s` : '—'}</dd>

            {statsData.fps != null && (
              <>
                <dt>Encode FPS</dt>
                <dd>{Number(statsData.fps).toFixed(1)}</dd>
              </>
            )}
            {statsData.speed != null && (
              <>
                <dt>Speed</dt>
                <dd>{Number(statsData.speed).toFixed(2)}×</dd>
              </>
            )}
            {statsData.timemark && (
              <>
                <dt>Encoded to</dt>
                <dd>{statsData.timemark}</dd>
              </>
            )}
          </dl>
        </div>
      )}

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
          onError={handlePlayerError}
          style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
        >
          <MediaProvider>
            {tracks.map((t, i) => (
              <Track
                key={`${t.src}-${i}`}
                src={t.src}
                kind={t.kind}
                language={t.language}
                label={t.label}
                default={t.default}
              />
            ))}
          </MediaProvider>
          <DefaultVideoLayout icons={defaultLayoutIcons} />
        </MediaPlayer>
      )}
    </div>
  )
}
