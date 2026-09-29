// Owns the server-side playback session: start, heartbeat (which rotates the short-lived playback
// token), recovery when the session dies (e.g. laptop slept), and ending it on unmount.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiUrl, deviceId, ApiError } from '../lib/api.js';

function endSession(sessionId, token) {
  // keepalive lets this complete even when the tab is closing.
  fetch(apiUrl(`/api/playback/${sessionId}/end`), { method: 'POST', keepalive: true, headers: { Authorization: `Bearer ${token}` } }).catch(
    () => {},
  );
}

export function usePlaybackSession(videoId, getPosition) {
  const [state, setState] = useState({ status: 'starting' });
  const session = useRef(null); // { sessionId, token, expiresAt, heartbeatInterval, manifestUrl, watermark }
  const refreshing = useRef(null);
  const alive = useRef(false);

  const start = useCallback(async () => {
    setState((s) => ({ ...s, status: 'starting' }));
    try {
      const s = await api('/api/playback', { method: 'POST', body: { videoId, deviceId: deviceId() } });
      if (!alive.current) return endSession(s.sessionId, s.token); // unmounted while starting
      session.current = { ...s, expiresAt: Date.now() + s.expiresIn * 1000 };
      // `generation` changes on every new session so the player knows to reload the source.
      setState((prev) => ({ status: 'ready', manifestUrl: apiUrl(s.manifestUrl), watermark: s.watermark, generation: (prev.generation ?? 0) + 1 }));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONCURRENT_LIMIT') {
        setState({ status: 'limit', error: err.message, sessions: err.body.sessions });
      } else {
        setState({ status: 'error', error: err.message });
      }
    }
  }, [videoId]);

  // Returns true if the token was rotated; on a dead session, starts a new one.
  const heartbeat = useCallback(() => {
    const s = session.current;
    if (!s) return Promise.resolve(false);
    refreshing.current ??= api(`/api/playback/${s.sessionId}/heartbeat`, {
      method: 'POST',
      token: s.token,
      body: { position: getPosition() },
    })
      .then((r) => {
        if (session.current === s) Object.assign(s, { token: r.token, expiresAt: Date.now() + r.expiresIn * 1000 });
        return true;
      })
      .catch((err) => {
        if (session.current !== s) return false;
        if (err.status === 403) setState({ status: 'error', error: err.message });
        else if (err.status === 401) start(); // expired token / stale session → open a fresh one and resume
        return false;
      })
      .finally(() => (refreshing.current = null));
    return refreshing.current;
  }, [getPosition, start]);

  // Always hands HLS.js a token with some life left in it.
  const getToken = useCallback(async () => {
    const s = session.current;
    if (s && s.expiresAt - Date.now() < 15_000) await heartbeat();
    return session.current?.token;
  }, [heartbeat]);

  useEffect(() => {
    alive.current = true;
    start();
    return () => {
      alive.current = false;
      const s = session.current;
      session.current = null;
      if (s) endSession(s.sessionId, s.token);
    };
  }, [start]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    const ms = (session.current?.heartbeatInterval ?? 30) * 1000;
    const id = setInterval(heartbeat, ms);
    // Background tabs get throttled; catch up as soon as the user comes back.
    const onVisible = () => document.visibilityState === 'visible' && heartbeat();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [state.status, state.generation, heartbeat]);

  const stopOtherSession = useCallback(
    async (id) => {
      await api(`/api/playback/sessions/${id}`, { method: 'DELETE' });
      await start();
    },
    [start],
  );

  return { ...state, getToken, restart: start, stopOtherSession };
}
