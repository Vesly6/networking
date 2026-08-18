import { useEffect, useRef, useState } from 'react';

const FRAME_COUNT = 6;
const FRAME_INTERVAL_MS = 180; // 2x slower than the original 90ms, per feedback
const FRAME_SRCS = Array.from({ length: FRAME_COUNT }, (_, i) => `/logo-anim/${i + 1}.png`);

// Preloaded once, module-level — every <BrandLogo> instance (Workspace
// header, table header) shares the same warm image cache, so the very
// first hover anywhere still animates smoothly instead of stalling on a
// network fetch for frame 1.
if (typeof window !== 'undefined') {
  FRAME_SRCS.forEach((src) => {
    const img = new Image();
    img.src = src;
  });
}

/** The header logo — a plain watermelon at rest, animating through a
 * 6-frame "being eaten" sequence on hover (plays once, holds on the last
 * frame while still hovered, resets on mouse-leave). */
export function BrandLogo() {
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const handleMouseEnter = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    let i = 1;
    setFrame(i);
    intervalRef.current = setInterval(() => {
      i += 1;
      if (i > FRAME_COUNT) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
      }
      setFrame(i);
    }, FRAME_INTERVAL_MS);
  };

  const handleMouseLeave = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setFrame(0);
  };

  return (
    <img
      src={frame === 0 ? '/favicon.png' : FRAME_SRCS[frame - 1]}
      alt=""
      className="brand-logo"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    />
  );
}
