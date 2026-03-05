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
const GREEN = "#22C55E";

interface CommandLine {
  prompt: string;
  cmd: string;
  comment: string;
  startFrame: number;
  accentColor: string;
}

const COMMANDS: CommandLine[] = [
  {
    prompt: "$",
    cmd: "npm i -g zvibe-kits",
    comment: "全局安装",
    startFrame: 60,
    accentColor: "#34D399",
  },
  {
    prompt: "$",
    cmd: "zvibe setup",
    comment: "一键初始化 · 安装依赖 · 配置 Agent",
    startFrame: 160,
    accentColor: CYAN,
  },
  {
    prompt: "$",
    cmd: "zvibe status --doctor",
    comment: "健康检查 · 诊断环境",
    startFrame: 260,
    accentColor: "#A78BFA",
  },
  {
    prompt: "$",
    cmd: "zvibe code",
    comment: "双 Agent 模式启动",
    startFrame: 360,
    accentColor: "#F59E0B",
  },
  {
    prompt: "$",
    cmd: "zvibe config wizard",
    comment: "交互式配置向导",
    startFrame: 460,
    accentColor: "#EC4899",
  },
];

const TypewriterCmd: React.FC<CommandLine> = ({
  prompt,
  cmd,
  comment,
  startFrame,
  accentColor,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const lineProgress = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 200 },
  });

  const typedChars = Math.max(
    0,
    Math.min(cmd.length, Math.floor((frame - startFrame - 10) / 3))
  );

  const commentOpacity = interpolate(
    frame,
    [startFrame + 10 + cmd.length * 3, startFrame + 10 + cmd.length * 3 + 25],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  if (frame < startFrame) return null;

  return (
    <div
      style={{
        opacity: lineProgress,
        transform: `translateX(${interpolate(lineProgress, [0, 1], [-20, 0])}px)`,
        display: "flex",
        alignItems: "center",
        gap: 0,
        padding: "12px 0",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      {/* prompt */}
      <span
        style={{
          fontFamily: mono,
          fontSize: 18,
          color: accentColor,
          opacity: 0.6,
          marginRight: 12,
          minWidth: 16,
        }}
      >
        {prompt}
      </span>
      {/* command */}
      <span
        style={{
          fontFamily: mono,
          fontSize: 22,
          color: WHITE,
          fontWeight: 400,
          flex: 1,
        }}
      >
        <span style={{ color: accentColor }}>{cmd.slice(0, 6)}</span>
        {cmd.slice(6, typedChars)}
        {typedChars < cmd.length && (
          <span
            style={{
              color: accentColor,
              opacity: Math.floor(frame / 12) % 2 === 0 ? 1 : 0.2,
            }}
          >
            ▋
          </span>
        )}
      </span>
      {/* comment */}
      <span
        style={{
          fontFamily: `"PingFang SC", "Microsoft YaHei", ${mono}, sans-serif`,
          fontSize: 14,
          color: DIM,
          opacity: commentOpacity,
          marginLeft: 20,
          whiteSpace: "nowrap",
        }}
      >
        # {comment}
      </span>
    </div>
  );
};

export const Commands: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleProgress = spring({ frame: frame - 0, fps, config: { damping: 200 } });
  const titleY = interpolate(titleProgress, [0, 1], [30, 0]);

  const lineWidth = interpolate(frame, [30, 100], [0, 180], {
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
          paddingBottom: 20,
        }}
      >
        {/* header */}
        <div
          style={{
            opacity: titleProgress,
            transform: `translateY(${titleY}px)`,
            textAlign: "center",
            marginBottom: 8,
          }}
        >
          <span
            style={{
              fontFamily: mono,
              fontSize: 13,
              color: CYAN,
              letterSpacing: "5px",
              textTransform: "uppercase",
              opacity: 0.7,
            }}
          >
            Quick Start
          </span>
        </div>

        <div
          style={{
            opacity: titleProgress,
            transform: `translateY(${titleY}px)`,
            marginBottom: 28,
          }}
        >
          <span
            style={{
              fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
              fontSize: 52,
              fontWeight: 700,
              color: WHITE,
            }}
          >
            快速上手
          </span>
        </div>

        <div
          style={{
            width: lineWidth,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${CYAN}, transparent)`,
            marginBottom: 36,
          }}
        />

        {/* terminal window */}
        <div
          style={{
            width: 820,
            borderRadius: 12,
            overflow: "hidden",
            border: "1px solid rgba(0,217,255,0.15)",
            background: "rgba(4,4,4,0.9)",
            boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
          }}
        >
          {/* title bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "14px 20px",
              background: "rgba(255,255,255,0.03)",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#FF5F57" }} />
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#FEBC2E" }} />
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#28C840" }} />
            <span
              style={{
                fontFamily: mono,
                fontSize: 12,
                color: DIM,
                marginLeft: 12,
                opacity: 0.6,
              }}
            >
              Terminal — zvibe-kits
            </span>
          </div>

          {/* content */}
          <div style={{ padding: "20px 28px" }}>
            {COMMANDS.map((cmd) => (
              <TypewriterCmd key={cmd.cmd} {...cmd} />
            ))}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
