/**
 * SpendexAI brand mark — the interlocking "S" formed by two flowing wedges.
 *
 * - The TOP wedge runs from upper-left to upper-right with a purple/blue
 *   gradient (`#3B82F6` → `#6D5BFF`).
 * - The BOTTOM wedge runs from lower-right to lower-left with a light/cyan
 *   gradient (`#E6E8EE` → `#00D4FF`).
 * - Together they form the recognizable "S" silhouette of the SpendexAI logo.
 *
 * Sizing: pass an explicit pixel size via the `size` prop. The SVG itself
 * uses a viewBox of 64×64 so the strokes scale crisply on any DPI.
 *
 * Backgrounds:
 *   <SpendexMark variant="light" />  — on white / light surfaces (default)
 *   <SpendexMark variant="dark"  />  — on dark surfaces, includes a subtle
 *                                      tile so the wedges contrast cleanly
 */
export interface SpendexMarkProps {
  size?: number;
  variant?: "light" | "dark";
  /** Optional className for layout hooks (margins, etc.). */
  className?: string;
  /** Set true if the mark is purely decorative — hides it from screen readers. */
  decorative?: boolean;
}

let idCounter = 0;
function useUniqueId(prefix: string): string {
  // Each <SpendexMark /> needs its own gradient IDs to avoid clashes when
  // multiple marks render on the same page. A simple monotonic counter is
  // enough — these IDs only live until the React tree unmounts.
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function SpendexMark({
  size = 28,
  variant = "light",
  className,
  decorative = false,
}: SpendexMarkProps) {
  const topId = useUniqueId("spx-top");
  const botId = useUniqueId("spx-bot");

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={decorative ? "presentation" : "img"}
      aria-label={decorative ? undefined : "SpendexAI"}
      aria-hidden={decorative ? true : undefined}
      className={className}
    >
      <defs>
        <linearGradient id={topId} x1="12" y1="8" x2="56" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#6D5BFF" />
        </linearGradient>
        <linearGradient id={botId} x1="52" y1="58" x2="8" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={variant === "dark" ? "#E6E8EE" : "#FFFFFF"} />
          <stop offset="55%" stopColor="#A5DDF5" />
          <stop offset="100%" stopColor="#00D4FF" />
        </linearGradient>
      </defs>

      {/* Top wedge — upper crescent of the S */}
      <path
        d="M 12 18 C 12 10, 18 6, 26 6 L 46 6 C 53 6, 58 11, 58 19 L 58 27 C 58 33, 53 36, 47 36 L 28 36 C 21 36, 16 32, 14 27 Z"
        fill={`url(#${topId})`}
      />

      {/* Bottom wedge — lower crescent of the S, mirrored */}
      <path
        d="M 52 46 C 52 54, 46 58, 38 58 L 18 58 C 11 58, 6 53, 6 45 L 6 37 C 6 31, 11 28, 17 28 L 36 28 C 43 28, 48 32, 50 37 Z"
        fill={`url(#${botId})`}
      />
    </svg>
  );
}
