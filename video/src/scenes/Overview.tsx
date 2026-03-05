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
const DIM = "#9CA3AF";

const FadeUp: React.FC<{
  children: React.ReactNode;
  startFrame: number;
  style?: React.CSSProperties;
}> = ({ children, startFrame, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - startFrame, fps, config: { damping: 200 } });
  const y = interpolate(progress, [0, 1], [32, 0]);
  return (
    <div style={{ opacity: progress, transform: `translateY(${y}px)`, ...style }}>
      {children}
    </div>
  );
};

const StatBlock: React.FC<{
  icon: string;
  label: string;
  startFrame: number;
}> = ({ icon, label, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - startFrame, fps, config: { damping: 200 } });
  const y = interpolate(progress, [0, 1], [40, 0]);

  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${y}px)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        padding: "28px 36px",
        border: `1px solid rgba(0,217,255,0.15)`,
        borderRadius: 12,
        background: "rgba(0,217,255,0.04)",
        minWidth: 200,
      }}
    >
      <span style={{ fontSize: 36 }}>{icon}</span>
      <span
        style={{
          fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
          fontSize: 17,
          fontWeight: 400,
          color: WHITE,
          letterSpacing: "2px",
          textAlign: "center",
        }}
      >
        {label}
      </span>
    </div>
  );
};

export const Overview: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const lineWidth = interpolate(frame, [30, 110], [0, 280], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <Background />
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 0,
          paddingBottom: 40,
        }}
      >
        {/* label */}
        <FadeUp startFrame={15}>
          <span
            style={{
              fontFamily: mono,
              fontSize: 13,
              color: CYAN,
              letterSpacing: "4px",
              textTransform: "uppercase",
              opacity: 0.8,
            }}
          >
            What is Zvibe Kits
          </span>
        </FadeUp>

        {/* title */}
        <FadeUp startFrame={40} style={{ marginTop: 16 }}>
          <span
            style={{
              fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
              fontSize: 56,
              fontWeight: 700,
              color: WHITE,
              letterSpacing: "1px",
            }}
          >
            一个命令，全部就绪
          </span>
        </FadeUp>

        {/* divider */}
        <div
          style={{
            width: lineWidth,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${CYAN}, transparent)`,
            marginTop: 28,
            marginBottom: 40,
          }}
        />

        {/* stat blocks */}
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", justifyContent: "center" }}>
          <StatBlock icon="📂" label="文件浏览" startFrame={100} />
          <StatBlock icon="📝" label="Git 提交" startFrame={130} />
          <StatBlock icon="🤖" label="AI Agent" startFrame={160} />
        </div>

        {/* subtitle */}
        <FadeUp startFrame={240} style={{ marginTop: 44 }}>
          <div style={{ textAlign: "center" }}>
            <span
              style={{
                fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
                fontSize: 22,
                color: DIM,
                letterSpacing: "2px",
                lineHeight: 1.8,
              }}
            >
              统一终端工作流 · 降低上下文切换成本
            </span>
          </div>
        </FadeUp>

        {/* command */}
        <FadeUp startFrame={300} style={{ marginTop: 28 }}>
          <div
            style={{
              padding: "14px 32px",
              borderRadius: 8,
              background: "rgba(0,0,0,0.6)",
              border: "1px solid rgba(0,217,255,0.2)",
            }}
          >
            <span
              style={{
                fontFamily: mono,
                fontSize: 20,
                color: CYAN,
              }}
            >
              <span style={{ color: "rgba(0,217,255,0.4)" }}>$ </span>
              zvibe
            </span>
          </div>
        </FadeUp>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
