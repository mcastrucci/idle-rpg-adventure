import { useEffect } from 'react';

/** Class on `<html>` while a live adventure owns the whole viewport (see `live-frame.css`). */
export const LIVE_FRAME_CLASS = 'live-frame-active';

/**
 * Turns the app into a single fixed `100dvh` frame while `on`: no document scroll, and the sanctuary header, tab bar and
 * banners step aside (the frame's breadcrumb row has the way back to the map). The class lives on `<html>` so the app
 * shell needs no knowledge of the live screen; it is always removed on cleanup, so leaving the screen restores the app.
 */
export function useLiveFrameMode(on: boolean): void {
  useEffect(() => {
    if (!on) return undefined;
    const root = document.documentElement;
    root.classList.add(LIVE_FRAME_CLASS);
    return () => root.classList.remove(LIVE_FRAME_CLASS);
  }, [on]);
}
