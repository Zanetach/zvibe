import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Background } from "../Background";
import { loadFont } from "@remotion/google-fonts/JetBrainsMono";

const { fontFamily: mono } = loadFont("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});

const CYAN = "#00D9FF";
const WHITE = "#FFFFFF";
const DIM = "#6B7280";

const Typewriter: React.FC<{ text: string; startFrame: number; framesPerChar: number; style?: React.CSSProperties }> = ({
  text, startFrame, framesPerChar, style,
}) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startFrame);
  const chars = Math.min(text.length, Math.floor(elapsed / framesPerChar));
  const showCursor = chars < text.length || (Math.floor(elapsed / 20) % 2 === 0);
  return (
    <span style={style}>
      {text.slice(0, chars)}
      {showCursor && chars <= text.length && (
        <span style={{ color: CYAN, opacity: 0.9 }}>█</span>
      )}
    </span>
  );
};

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // "zvibe" types in from frame 60
  const zvibeTyped = Math.min(5, Math.max(0, Math.floor((frame - 60) / 13)));
  const zvibeText = "zvibe".slice(0, zvibeTyped);
  const showZvibeCursor = zvibeTyped < 5 && frame >= 60;

  // "kits" slides up from frame 145
  const kitsProgress = spring({
    frame: frame - 145,
    fps,
    config: { damping: 200 },
  });
  const kitsY = interpolate(kitsProgress, [0, 1], [40, 0]);
  const kitsOpacity = kitsProgress;

  // tagline fades up from frame 210
  const taglineProgress = spring({
    frame: frame - 210,
    fps,
    config: { damping: 200 },
  });
  const taglineY = interpolate(taglineProgress, [0, 1], [30, 0]);
  const taglineOpacity = taglineProgress;

  // "for macOS" fades in from frame 310
  const macosOpacity = interpolate(frame, [310, 360], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // divider line grows from frame 185
  const lineWidth = interpolate(frame, [185, 270], [0, 340], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // overall bg fade in
  const bgOpacity = interpolate(frame, [0, 45], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: bgOpacity }}>
      <Background />
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 0,
        }}
      >
        {/* Main title */}
        <div style={{ textAlign: "center", lineHeight: 1 }}>
          <span
            style={{
              fontFamily: mono,
              fontSize: 130,
              fontWeight: 700,
              color: CYAN,
              letterSpacing: "-4px",
              textShadow: `0 0 60px rgba(0, 217, 255, 0.5), 0 0 120px rgba(0, 217, 255, 0.2)`,
            }}
          >
            {zvibeText}
            {showZvibeCursor && (
              <span style={{ opacity: Math.floor(frame / 15) % 2 === 0 ? 1 : 0.2 }}>█</span>
            )}
          </span>
        </div>

        {/* kits */}
        <div
          style={{
            opacity: kitsOpacity,
            transform: `translateY(${kitsY}px)`,
            marginTop: -8,
          }}
        >
          <span
            style={{
              fontFamily: mono,
              fontSize: 48,
              fontWeight: 400,
              color: "rgba(255,255,255,0.75)",
              letterSpacing: "14px",
              textTransform: "uppercase",
            }}
          >
            kits
          </span>
        </div>

        {/* divider */}
        <div
          style={{
            width: lineWidth,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${CYAN}, transparent)`,
            marginTop: 28,
            marginBottom: 28,
          }}
        />

        {/* tagline */}
        <div
          style={{
            opacity: taglineOpacity,
            transform: `translateY(${taglineY}px)`,
          }}
        >
          <span
            style={{
              fontFamily: `"PingFang SC", "Microsoft YaHei", ${mono}, sans-serif`,
              fontSize: 28,
              fontWeight: 400,
              color: WHITE,
              letterSpacing: "4px",
            }}
          >
            多 Agent 开发工作台启动器
          </span>
        </div>

        {/* for macOS */}
        <div
          style={{
            opacity: macosOpacity,
            marginTop: 14,
          }}
        >
          <span
            style={{
              fontFamily: mono,
              fontSize: 15,
              fontWeight: 400,
              color: DIM,
              letterSpacing: "3px",
              textTransform: "uppercase",
            }}
          >
            for macOS · Ghostty / Zellij
          </span>
        </div>
      </AbsoluteFill>

      {/* version badge */}
      <div
        style={{
          position: "absolute",
          bottom: 48,
          right: 64,
          opacity: macosOpacity,
          fontFamily: mono,
          fontSize: 13,
          color: "rgba(0,217,255,0.5)",
          letterSpacing: "1px",
        }}
      >
        v1.3.4
      </div>
    </AbsoluteFill>
  );
};
