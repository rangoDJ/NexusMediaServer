import { useEffect, useRef, useState, useCallback } from 'react'
import Hls from 'hls.js'
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

// MIME for native <video src type=...> when direct-playing
const MIME_BY_CONTAINER = {
  mp4:  'video/mp4',
  m4v:  'video/mp4',
  webm: 'video/webm',
  mov:  'video/quicktime',
  mkv:  'video/x-matroska',
}

// How far past the buffered end a seek target can be before we give up on
// native in-buffer seeking and restart the transcode at that position.
// Within this window the transcoder (running at 2-4x real-time) naturally
// catches up.
const SEEK_RESTART_THRESHOLD_SECS = 30

export function formatBitrate(kbps) {
  if (!kbps) return '—'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} Kbps`
}

export function formatTime(secs) {
  if (secs == null || !isFinite(secs) || secs < 0) return '0:00'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/** Parse the standard WebVTT-with-media-fragments trickplay format
 *  ("HH:MM:SS.mmm --> HH:MM:SS.mmm" cues, each pointing at
 *  "trickplay.jpg#xywh=x,y,w,h") into a flat array of sprite regions. */
export function parseTrickplayVtt(text) {
  const TIME_RE = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/
  const XYWH_RE = /xywh=(\d+),(\d+),(\d+),(\d+)/
  const toSecs = (h, m, s, ms) => (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000

  const cues = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.trim().split('\n')
    const timeLine = lines.find(l => TIME_RE.test(l))
    const xywhLine = lines.find(l => XYWH_RE.test(l))
    if (!timeLine || !xywhLine) continue
    const t = timeLine.match(TIME_RE)
    const x = xywhLine.match(XYWH_RE)
    cues.push({
      start: toSecs(t[1], t[2], t[3], t[4]),
      end:   toSecs(t[5], t[6], t[7], t[8]),
      x: +x[1], y: +x[2], w: +x[3], h: +x[4],
    })
  }
  return cues
}

export default function Player({ mediaItemId, episodeId, title, onEnded }) {
  const wrapRef   = useRef(null)
  const videoRef  = useRef(null)
  const hlsRef    = useRef(null) // current hls.js instance, if any
  const lastSaveRef   = useRef(0)
  const menuRef        = useRef(null) // quality menu — outside-click detection
  const subtitleMenuRef = useRef(null)
  const hideControlsTimerRef = useRef(null)

  // Trickplay sprite cues — [{start, end, x, y, w, h}], absolute file time
  const [trickplayCues, setTrickplayCues] = useState([])
  const [trickplayUrl, setTrickplayUrl]   = useState(null) // sprite jpg URL
  // Intro/credits segment windows for this episode
  const [segments, setSegments] = useState([])
  const [showSkipIntro, setShowSkipIntro] = useState(false)

  // Tracks the src object currently attached. Used to detect whether a
  // stream is already playing when a quality change is requested so we can
  // show a switching overlay instead of blanking the screen.
  const activeSrcRef = useRef(null)
  // Absolute offset (seconds) where the current HLS stream begins inside
  // the source file. 0 unless a server-side seek restart shifted it.
  const currentStreamOffsetRef = useRef(0)
  // Set (to an absolute file position) when the user seeks far beyond the
  // buffer, or when the quality preset changes mid-playback — both need the
  // new transcode session to begin at the exact position the old one left
  // off, not from 0. null = no restart requested, start fresh/resume from
  // saved progress instead. Explicitly nullable (not 0) so a legitimate
  // restart-at-position-0 isn't mistaken for "nothing requested".
  const nextSeekOffsetRef = useRef(null)
  // Mirrors the active transcoder session ID so start() can DELETE the old
  // session immediately without waiting for React state to propagate.
  const liveSessionRef = useRef(null)

  const [src, setSrc]                 = useState(null) // { src, type }
  const [sessionId, setSessionId]     = useState(null) // null => direct play
  const [seekTo, setSeekToState]      = useState(0)     // stream-relative resume target
  const [error, setError]             = useState(null)
  const [mode, setMode]               = useState(null) // 'direct' | 'abr' | 'transcode'
  const [tracks, setTracks]           = useState([])   // subtitle tracks
  const [activeTrackIndex, setActiveTrackIndex] = useState(-1) // -1 = off
  const [playbackInfo, setPlaybackInfo] = useState(null)
  const [quality, setQuality]         = useState(() =>
    localStorage.getItem('nexus_quality') ?? DEFAULT_QUALITY
  )
  const [menuOpen, setMenuOpen]               = useState(false)
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false)
  const [retryTrigger, setRetryTrigger] = useState(0)
  const [showStats, setShowStats]     = useState(false)
  const [statsData, setStatsData]     = useState({})
  const [switching, setSwitching]     = useState(false)

  // ── Native playback state (replaces vidstack's store) ────────────────────
  const [isPlaying, setIsPlaying]     = useState(false)
  const [isBuffering, setIsBuffering] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)   // stream-relative
  const [duration, setDuration]       = useState(0)   // stream-relative (native)
  const [bufferedEnd, setBufferedEnd] = useState(0)    // stream-relative
  const [volume, setVolume]           = useState(() => Number(localStorage.getItem('nexus_volume') ?? 1))
  const [muted, setMuted]             = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  // While the user is dragging the seek bar: freeze the displayed position at
  // the drag target instead of the actual (stale) video.currentTime.
  const [scrubTime, setScrubTime]     = useState(null) // absolute seconds, or null when not scrubbing
  const [hoverPreview, setHoverPreview] = useState(null) // { x: pixels, time: absolute } | null

  const progressPath = episodeId
    ? `/media/episode/${episodeId}/progress`
    : `/media/${mediaItemId}/progress`

  // The seek bar's true total length — server-known runtime, NOT whatever
  // hls.js currently reports (which for a growing transcode is only the
  // sum of segments produced so far). This is the actual fix for the old
  // "red line" bug: the UI never asks the player for duration at all.
  const absoluteDuration = playbackInfo?.file?.duration_secs ?? (currentStreamOffsetRef.current + duration)
  const absoluteCurrentTime = scrubTime ?? (currentStreamOffsetRef.current + currentTime)
  const absoluteBufferedEnd = currentStreamOffsetRef.current + bufferedEnd

  // ── Load trickplay + intro/credits segments when item changes ────────────
  useEffect(() => {
    const base = episodeId
      ? `/api/v1/media/episode/${episodeId}`
      : `/api/v1/media/${mediaItemId}`

    const vttUrl = `${base}/trickplay.vtt`
    fetch(vttUrl, { credentials: 'same-origin' })
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(text => {
        setTrickplayCues(parseTrickplayVtt(text))
        setTrickplayUrl(`${base}/trickplay.jpg`)
      })
      .catch(() => { setTrickplayCues([]); setTrickplayUrl(null) })

    if (episodeId) {
      api.get(`/media/episode/${episodeId}/segments`)
        .then(r => setSegments(r.data ?? []))
        .catch(() => setSegments([]))
    } else {
      setSegments([])
    }
    setShowSkipIntro(false)
  }, [mediaItemId, episodeId])

  // ── Start / restart playback ──────────────────────────────────────────────
  // - quality === 'auto'  → prefer direct play, fall back to transcoded HLS
  // - quality === preset  → force transcode at that bitrate
  // - nextSeekOffsetRef   → non-zero means restart from that absolute position
  useEffect(() => {
    let cancelled = false

    async function start() {
      const prevSession = liveSessionRef.current
      liveSessionRef.current = null
      // Awaited, not fire-and-forget: the new session's capacity check
      // (pickTranscoder) runs server-side almost immediately after this, and
      // a capped transcoder (max_sessions) would otherwise still see the old
      // session's slot as occupied and reject the new one with "No
      // transcoder nodes available" — a race that only shows up on quality
      // switches and out-of-buffer seeks, since a fresh load has no prior
      // session to race against.
      if (prevSession) await api.delete(`/stream/${prevSession}`).catch(() => {})

      const wasPlaying = activeSrcRef.current !== null
      if (wasPlaying) {
        saveProgress()
        setSwitching(true)
      } else {
        activeSrcRef.current = null
        setSrc(null)
      }
      setError(null)

      try {
        // Absolute file position, or null if this is a fresh load / no
        // restart requested (in which case we resume from saved progress
        // instead). Set by seekToAbsolute() for out-of-buffer seeks AND by
        // changeQuality() — a quality change must restart the transcode at
        // the current position too, otherwise the new session starts from 0
        // and the player is left waiting forever for content that won't
        // exist until ffmpeg sequentially encodes all the way back to where
        // playback actually was.
        const startTimeSecs = nextSeekOffsetRef.current
        nextSeekOffsetRef.current = null

        let savedPos = 0
        if (startTimeSecs == null) {
          try {
            const { data: prog } = await api.get(progressPath)
            savedPos = Math.max(0, prog.position_secs ?? 0)
          } catch {}
        }

        const preset = QUALITY_PRESETS.find(p => p.id === quality) ?? QUALITY_PRESETS[0]

        let pi = null
        try { pi = await fetchPlaybackInfo() } catch {}

        if (!cancelled) {
          setTracks(buildTrackList(pi))
          setPlaybackInfo(pi)
        }

        function commitSrc(newSrc) {
          activeSrcRef.current = newSrc
          setSrc(newSrc)
          setSwitching(false)
        }

        if (preset.id === 'auto' && pi?.playback?.direct_play && pi?.playback?.direct_play_url) {
          // Direct play always serves the whole file — there's no "stream
          // offset" concept the way a partial transcode has; seeking is
          // just a native in-file jump to the absolute target position.
          currentStreamOffsetRef.current = 0
          const target = startTimeSecs ?? savedPos
          const url   = pi.playback.direct_play_url
          const type  = MIME_BY_CONTAINER[pi.file?.container?.toLowerCase()] ?? 'video/mp4'
          if (cancelled) return
          setMode('direct')
          setSessionId(null)
          if (target > 5) setSeekToState(target)
          commitSrc({ src: url, type })
          return
        }

        // Transcode/ABR: when a restart was requested, the new stream begins
        // exactly at startTimeSecs (baked in as ffmpeg's -ss input offset
        // server-side) — so its own timeline starts at 0, no post-load seek
        // needed. Only a fresh load (no restart) needs to jump to savedPos
        // once the stream is ready.
        currentStreamOffsetRef.current = startTimeSecs ?? 0

        const params = preset.id === 'auto'
          ? { codec: 'h264', resolution: '1080p', variants: true }
          : { codec: 'h264', resolution: preset.resolution, bitrate: preset.bitrate }

        const { data } = await api.post('/stream/start', {
          media_item_id: mediaItemId ?? undefined,
          episode_id:    episodeId ?? undefined,
          ...params,
          ...(startTimeSecs != null ? { start_time_secs: startTimeSecs } : {}),
        })
        if (cancelled) {
          api.delete(`/stream/${data.session_id}`).catch(() => {})
          return
        }
        liveSessionRef.current = data.session_id
        setMode(data.abr ? 'abr' : 'transcode')
        setSessionId(data.session_id)
        if (savedPos > 5) setSeekToState(savedPos)
        commitSrc({ src: data.playlist_url, type: 'application/x-mpegurl' })
      } catch (e) {
        if (!cancelled) {
          setSwitching(false)
          activeSrcRef.current = null
          setSrc(null)
          setError(e.response?.data?.error ?? e.message)
        }
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

  function buildTrackList(pi) {
    if (!pi?.subtitle_tracks?.length) return []
    return pi.subtitle_tracks.map(t => ({
      src:      t.url,
      kind:     'subtitles',
      language: t.language ?? 'und',
      label:    [t.title, t.language?.toUpperCase(), t.forced ? '(forced)' : '']
                  .filter(Boolean).join(' · ') || `Track ${t.stream_index}`,
      default:  !!t.default,
    }))
  }

  // ── hls.js lifecycle — attach/detach whenever src changes ─────────────────
  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    hlsRef.current?.destroy()
    hlsRef.current = null

    if (src.type === 'application/x-mpegurl') {
      // Always prefer hls.js over native HLS, even on Safari/iOS where the
      // browser could technically play it natively — for consistent ABR
      // behavior, error reporting, and the timeout tuning below (auth itself
      // is no longer a factor either way: both hls.js's XHRs and a native
      // <video src> automatically carry the httpOnly auth cookie for these
      // same-origin requests).
      if (Hls.isSupported()) {
        const hls = new Hls({
          // Our API holds the playlist request open for up to 20s while
          // ffmpeg starts producing segments — hls.js's 10s default fires
          // before the server responds, causing a spurious network-timeout.
          manifestLoadingTimeOut:    30_000,
          manifestLoadingMaxRetry:   2,
          manifestLoadingRetryDelay: 500,
          levelLoadingTimeOut:       25_000,
          fragLoadingTimeOut:        20_000,
        })
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          console.error('[Player] hls.js error:', data)
          if (data.fatal) handlePlayerError(`${data.type}: ${data.details}`)
        })
        hls.loadSource(src.src)
        hls.attachMedia(video)
        hlsRef.current = hls
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Only as a last resort when hls.js genuinely can't run in this browser.
        video.src = src.src
      } else {
        setError('HLS playback is not supported in this browser')
      }
    } else {
      video.src = src.src
    }

    return () => {
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [src])

  // ── Volume / mute — imperative sync (native properties, not JSX props) ───
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = muted
  }, [volume, muted, src])

  // ── Subtitle track selection — imperative sync via TextTrack API ─────────
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = i === activeTrackIndex ? 'showing' : 'disabled'
    }
  }, [activeTrackIndex, tracks])

  // Default subtitle track once tracks load for a new item
  useEffect(() => {
    const defaultIdx = tracks.findIndex(t => t.default)
    setActiveTrackIndex(defaultIdx)
  }, [tracks])

  // ── Fullscreen tracking ────────────────────────────────────────────────
  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(document.fullscreenElement === wrapRef.current)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  // ── Close menus on outside click ──────────────────────────────────────────
  useEffect(() => {
    if (!menuOpen && !subtitleMenuOpen) return
    function onClick(e) {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
      if (subtitleMenuOpen && subtitleMenuRef.current && !subtitleMenuRef.current.contains(e.target)) setSubtitleMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [menuOpen, subtitleMenuOpen])

  // ── Auto-hide controls while playing ──────────────────────────────────────
  const wakeControls = useCallback(() => {
    setControlsVisible(true)
    clearTimeout(hideControlsTimerRef.current)
    hideControlsTimerRef.current = setTimeout(() => {
      if (isPlaying) setControlsVisible(false)
    }, 3000)
  }, [isPlaying])

  useEffect(() => {
    if (!isPlaying) { setControlsVisible(true); clearTimeout(hideControlsTimerRef.current); return }
    wakeControls()
    return () => clearTimeout(hideControlsTimerRef.current)
  }, [isPlaying, wakeControls])

  // ── Stats overlay polling ──────────────────────────────────────────────
  useEffect(() => {
    if (!showStats) { setStatsData({}); return }

    let cancelled = false

    function readBuffer() {
      const video = videoRef.current
      if (!video) return null
      const ct = video.currentTime ?? 0
      const buf = video.buffered
      if (!buf || buf.length === 0) return null
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf.start(i) <= ct + 0.1) return Math.max(0, buf.end(i) - ct)
      }
      return null
    }

    async function tick() {
      if (cancelled) return
      setStatsData(prev => ({ ...prev, bufferAhead: readBuffer() }))
      if (sessionId) {
        try {
          const { data } = await api.get(`/stream/${sessionId}/metrics`)
          if (!cancelled) setStatsData(prev => ({ ...prev, ...data }))
        } catch {}
      }
    }

    tick()
    const id = setInterval(tick, 2000)
    return () => { cancelled = true; clearInterval(id) }
  }, [showStats, sessionId])

  function changeQuality(newId) {
    setMenuOpen(false)
    if (newId === quality) return
    nextSeekOffsetRef.current = currentStreamOffsetRef.current + Math.floor(videoRef.current?.currentTime ?? 0)
    localStorage.setItem('nexus_quality', newId)
    setQuality(newId)
  }

  function onCanPlay() {
    if (seekTo > 0 && videoRef.current) {
      videoRef.current.currentTime = seekTo
      setSeekToState(0)
    }
  }

  // Core seek primitive — everything (seek bar, skip intro, keyboard) goes
  // through this. `absoluteTarget` is a position in the whole file. In-buffer
  // targets seek natively; anything further ahead restarts the transcode at
  // that exact position instead of stalling waiting for ffmpeg to catch up.
  function seekToAbsolute(absoluteTarget) {
    const video = videoRef.current
    if (!video) return
    const target = Math.max(0, absoluteTarget)

    if (mode === 'direct') {
      video.currentTime = target
      return
    }

    const streamRelative = target - currentStreamOffsetRef.current
    const buf = video.buffered
    let bEnd = 0
    for (let i = 0; i < buf.length; i++) {
      if (buf.start(i) <= streamRelative + 1) bEnd = Math.max(bEnd, buf.end(i))
    }

    if (streamRelative <= bEnd + SEEK_RESTART_THRESHOLD_SECS && streamRelative >= 0) {
      video.currentTime = streamRelative
    } else {
      nextSeekOffsetRef.current = Math.floor(target)
      setRetryTrigger(n => n + 1)
    }
  }

  function saveProgress() {
    const video = videoRef.current
    if (!video) return
    const pos = currentStreamOffsetRef.current + Math.floor(video.currentTime ?? 0)
    const dur = Math.floor(
      playbackInfo?.file?.duration_secs ??
      (currentStreamOffsetRef.current + (video.duration ?? 0))
    )
    if (!dur || pos < 2) return
    const completed = pos / dur > 0.9
    api.put(progressPath, { position_secs: pos, duration_secs: dur, completed }).catch(() => {})
  }

  function onTimeUpdate() {
    const video = videoRef.current
    if (!video) return
    setCurrentTime(video.currentTime ?? 0)

    const now = Date.now()
    if (now - lastSaveRef.current > 15_000) {
      lastSaveRef.current = now
      saveProgress()
    }
    const absoluteTime = currentStreamOffsetRef.current + (video.currentTime ?? 0)
    const introSeg = segments.find(s => s.type === 'intro')
    if (introSeg) {
      setShowSkipIntro(absoluteTime >= introSeg.start_secs && absoluteTime < introSeg.end_secs)
    }
  }

  function onDurationChange() {
    setDuration(videoRef.current?.duration || 0)
  }

  function onProgress() {
    const video = videoRef.current
    if (!video) return
    const buf = video.buffered
    let end = 0
    for (let i = 0; i < buf.length; i++) end = Math.max(end, buf.end(i))
    setBufferedEnd(end)
  }

  function handlePlayerError(detail) {
    const video = videoRef.current
    // Log everything available — readyState/networkState/currentSrc pin down
    // whether this was a native demux failure vs. an hls.js-level error, and
    // which URL it actually happened on, without needing to reproduce live.
    console.error('[Player] error:', detail, {
      readyState:   video?.readyState,
      networkState: video?.networkState,
      currentSrc:   video?.currentSrc,
      mode, src,
    })
    const msg = typeof detail === 'string' ? detail : (detail?.message ?? 'stream failed to load')
    setError(msg)
  }

  function handleEnded() {
    const video = videoRef.current
    const dur = Math.floor(
      playbackInfo?.file?.duration_secs ??
      (currentStreamOffsetRef.current + (video?.duration ?? 0))
    )
    if (dur > 0) {
      api.put(progressPath, { position_secs: dur, duration_secs: dur, completed: true }).catch(() => {})
    }
    onEnded?.()
  }

  // ── Play/pause/mute/fullscreen controls ───────────────────────────────────
  function togglePlay() {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch(() => {})
    else video.pause()
  }

  function toggleMute() {
    setMuted(m => !m)
  }

  function onVolumeChange(e) {
    const v = Number(e.target.value)
    setVolume(v)
    setMuted(v === 0)
    localStorage.setItem('nexus_volume', String(v))
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else wrapRef.current?.requestFullscreen().catch(() => {})
  }

  // ── Seek bar interaction ───────────────────────────────────────────────
  function seekBarTimeFromEvent(e, barEl) {
    const rect = barEl.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    return frac * absoluteDuration
  }

  function onSeekBarPointerMove(e) {
    const time = seekBarTimeFromEvent(e, e.currentTarget)
    setHoverPreview({ x: e.clientX - e.currentTarget.getBoundingClientRect().left, time })
    if (scrubTime != null) setScrubTime(time)
  }

  function onSeekBarPointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId)
    setScrubTime(seekBarTimeFromEvent(e, e.currentTarget))
  }

  function onSeekBarPointerUp() {
    if (scrubTime == null) return
    const target = scrubTime
    setScrubTime(null)
    seekToAbsolute(target)
  }

  function onSeekBarLeave() {
    setHoverPreview(null)
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e) {
      if (!wrapRef.current) return
      // Ignore when focus is in an input/textarea/menu elsewhere on the page
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          seekToAbsolute(absoluteCurrentTime - 10)
          break
        case 'ArrowRight':
          e.preventDefault()
          seekToAbsolute(absoluteCurrentTime + 10)
          break
        case 'f':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'm':
          e.preventDefault()
          toggleMute()
          break
        default:
          break
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absoluteCurrentTime, mode])

  // Final cleanup on unmount only.
  useEffect(() => {
    return () => {
      saveProgress()
      hlsRef.current?.destroy()
      const s = liveSessionRef.current
      liveSessionRef.current = null
      if (s) api.delete(`/stream/${s}`).catch(() => {})
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  const seekPct = absoluteDuration > 0 ? Math.min(100, (absoluteCurrentTime / absoluteDuration) * 100) : 0
  const bufferedPct = absoluteDuration > 0 ? Math.min(100, (absoluteBufferedEnd / absoluteDuration) * 100) : 0

  const hoverCue = hoverPreview && trickplayUrl
    ? trickplayCues.find(c => hoverPreview.time >= c.start && hoverPreview.time < c.end)
    : null

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      onMouseMove={wakeControls}
      onClick={() => src && togglePlay()}
    >
      {/* Top-right controls: stats toggle + subtitle + quality pickers */}
      <div className={`${styles.topControls} ${controlsVisible ? '' : styles.controlsHidden}`} onClick={e => e.stopPropagation()}>
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

        {tracks.length > 0 && (
          <div className={styles.qualityWrap} ref={subtitleMenuRef}>
            <button
              className={styles.statsBtn}
              onClick={() => setSubtitleMenuOpen(o => !o)}
              aria-label="Subtitles"
              title="Subtitles"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/>
                <rect x="5" y="14" width="6" height="2" fill="currentColor"/>
                <rect x="13" y="14" width="6" height="2" fill="currentColor"/>
              </svg>
            </button>
            {subtitleMenuOpen && (
              <div className={styles.qualityMenu}>
                <div className={styles.qualityMenuTitle}>Subtitles</div>
                <button
                  className={`${styles.qualityItem} ${activeTrackIndex === -1 ? styles.qualityActive : ''}`}
                  onClick={() => { setActiveTrackIndex(-1); setSubtitleMenuOpen(false) }}
                >
                  <span>Off</span>
                </button>
                {tracks.map((t, i) => (
                  <button
                    key={t.src}
                    className={`${styles.qualityItem} ${activeTrackIndex === i ? styles.qualityActive : ''}`}
                    onClick={() => { setActiveTrackIndex(i); setSubtitleMenuOpen(false) }}
                  >
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

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

      {!src && !switching && <div className={styles.loadingBox}>Starting stream…</div>}

      {switching && (
        <div className={styles.switchingOverlay}>
          <div className={styles.switchingSpinner} />
          <span>Switching quality…</span>
        </div>
      )}

      {showSkipIntro && src && (
        <button
          className={styles.skipIntroBtn}
          onClick={(e) => {
            e.stopPropagation()
            const introSeg = segments.find(s => s.type === 'intro')
            if (!introSeg) return
            seekToAbsolute(introSeg.end_secs)
            setShowSkipIntro(false)
          }}
        >
          Skip Intro
        </button>
      )}

      {isBuffering && src && !switching && (
        <div className={styles.bufferingSpinner} />
      )}

      {src && !isPlaying && !switching && !isBuffering && (
        <button className={styles.centerPlayBtn} onClick={(e) => { e.stopPropagation(); togglePlay() }} aria-label="Play">
          ▶
        </button>
      )}

      {src && (
        <video
          ref={videoRef}
          autoPlay
          crossOrigin="anonymous"
          playsInline
          onCanPlay={onCanPlay}
          onTimeUpdate={onTimeUpdate}
          onDurationChange={onDurationChange}
          onProgress={onProgress}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onWaiting={() => setIsBuffering(true)}
          onPlaying={() => setIsBuffering(false)}
          onEnded={handleEnded}
          onError={() => handlePlayerError(videoRef.current?.error?.message)}
          style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
        >
          {tracks.map((t) => (
            <track key={t.src} src={t.src} kind={t.kind} srcLang={t.language} label={t.label} />
          ))}
        </video>
      )}

      {/* Custom control bar */}
      {src && (
        <div className={`${styles.controlBar} ${controlsVisible ? '' : styles.controlsHidden}`} onClick={e => e.stopPropagation()}>
          <div
            className={styles.seekBar}
            onPointerDown={onSeekBarPointerDown}
            onPointerMove={onSeekBarPointerMove}
            onPointerUp={onSeekBarPointerUp}
            onPointerLeave={onSeekBarLeave}
          >
            {hoverCue && trickplayUrl && (
              <div
                className={styles.trickplayPreview}
                style={{
                  left: `${hoverPreview.x}px`,
                  width: hoverCue.w, height: hoverCue.h,
                  backgroundImage: `url(${trickplayUrl})`,
                  backgroundPosition: `-${hoverCue.x}px -${hoverCue.y}px`,
                }}
              >
                <span className={styles.trickplayTime}>{formatTime(hoverPreview.time)}</span>
              </div>
            )}
            <div className={styles.seekTrack}>
              <div className={styles.seekBuffered} style={{ width: `${bufferedPct}%` }} />
              <div className={styles.seekFill} style={{ width: `${seekPct}%` }} />
              <div className={styles.seekThumb} style={{ left: `${seekPct}%` }} />
            </div>
          </div>

          <div className={styles.controlRow}>
            <button className={styles.controlBtn} onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? '❚❚' : '▶'}
            </button>

            <div className={styles.volumeWrap}>
              <button className={styles.controlBtn} onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted || volume === 0 ? '🔇' : '🔊'}
              </button>
              <input
                className={styles.volumeSlider}
                type="range" min="0" max="1" step="0.05"
                value={muted ? 0 : volume}
                onChange={onVolumeChange}
                aria-label="Volume"
              />
            </div>

            <span className={styles.timeText}>
              {formatTime(absoluteCurrentTime)} / {formatTime(absoluteDuration)}
            </span>

            <div style={{ flex: 1 }} />

            <button className={styles.controlBtn} onClick={toggleFullscreen} aria-label="Fullscreen">
              {isFullscreen ? '⤢' : '⛶'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
