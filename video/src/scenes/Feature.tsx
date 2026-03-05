import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  Sequence,
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
const PURPLE = "#7C3AED";

const FadeUp: React.FC<{
  children: React.ReactNode;
  startFrame: number;
  style?: React.CSSProperties;
}> = ({ children, startFrame, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - startFrame, fps, config: { damping: 200 } });
  const y = interpolate(progress, [0, 1], [28, 0]);
  return (
    <div style={{ opacity: progress, transform: `translateY(${y}px)`, ...style }}>
      {children}
    </div>
  );
};

// ── Scene A: 多 Agent 启动 ─────────────────────────────────────────────────

const AgentCard: React.FC<{
  cmd: string;
  agent: string;
  color: string;
  startFrame: number;
}> = ({ cmd, agent, color, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - startFrame, fps, config: { damping: 20, stiffness: 200 } });
  const y = interpolate(progress, [0, 1], [50, 0]);
  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${y}px)`,
        padding: "22px 36px",
        borderRadius: 10,
        background: "rgba(0,0,0,0.55)",
        border: `1px solid ${color}40`,
        minWidth: 260,
        boxShadow: `0 0 30px ${color}15`,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 13,
          color: `${color}99`,
          letterSpacing: "2px",
          marginBottom: 8,
          textTransform: "uppercase",
        }}
      >
        {agent}
      </div>
      <div
        style={{
          fontFamily: mono,
          fontSize: 22,
          color,
          fontWeight: 700,
        }}
      >
        {cmd}
      </div>
    </div>
  );
};

export const FeatureMultiAgent: React.FC = () => {
  const frame = useCurrentFrame();
  const lineWidth = interpolate(frame, [20, 90], [0, 200], {
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
        }}
      >
        <FadeUp startFrame={10}>
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
            Core Feature 01
          </span>
        </FadeUp>

        <FadeUp startFrame={30} style={{ marginTop: 16 }}>
          <span
            style={{
              fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
              fontSize: 52,
              fontWeight: 700,
              color: WHITE,
            }}
          >
            多 Agent 启动
          </span>
        </FadeUp>

        <div
          style={{
            width: lineWidth,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${CYAN}, transparent)`,
            marginTop: 24,
            marginBottom: 48,
          }}
        />

        <div style={{ display: "flex", gap: 20 }}>
          <AgentCard cmd="zvibe codex" agent="OpenAI Codex" color={CYAN} startFrame={100} />
          <AgentCard cmd="zvibe claude" agent="Anthropic Claude" color="#A78BFA" startFrame={130} />
          <AgentCard cmd="zvibe opencode" agent="OpenCode" color="#34D399" startFrame={160} />
        </div>

        <FadeUp startFrame={230} style={{ marginTop: 44 }}>
          <span
            style={{
              fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
              fontSize: 18,
              color: DIM,
              letterSpacing: "2px",
            }}
          >
            支持主流 AI Coding Agent · 一键切换
          </span>
        </FadeUp>
      </AbsoluteFill>

      {/* number watermark */}
      <div
        style={{
          position: "absolute",
          right: 64,
          bottom: 48,
          fontFamily: mono,
          fontSize: 100,
          fontWeight: 700,
          color: "rgba(0,217,255,0.04)",
          lineHeight: 1,
        }}
      >
        01
      </div>
    </AbsoluteFill>
  );
};

// ── Scene B: Agent Mode + 终端面板布局 ────────────────────────────────────

const LayoutDiagram: React.FC<{ startFrame: number }> = ({ startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const rows = [
    "┌─────────────┬──────────────────────────┐",
    "│  📂  yazi   │                          │",
    "│   文件浏览  │       🤖  Agent          │",
    "├─────────────┤                          │",
    "│  📝  lazygit│                          │",
    "│   Git 提交  │                          │",
    "└─────────────┴──────────────────────────┘",
  ];

  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 16,
        color: "rgba(0,217,255,0.8)",
        lineHeight: 1.6,
        padding: "20px 28px",
        background: "rgba(0,0,0,0.5)",
        borderRadius: 8,
        border: "1px solid rgba(0,217,255,0.15)",
      }}
    >
      {rows.map((row, i) => {
        const rowStartFrame = startFrame + i * 14;
        const rowProgress = spring({
          frame: frame - rowStartFrame,
          fps,
          config: { damping: 200 },
        });
        return (
          <div
            key={i}
            style={{
              opacity: rowProgress,
              transform: `translateX(${interpolate(rowProgress, [0, 1], [-10, 0])}px)`,
              whiteSpace: "pre",
            }}
          >
            {row}
          </div>
        );
      })}
    </div>
  );
};

export const FeatureLayout: React.FC = () => {
  const frame = useCurrentFrame();
  const lineWidth = interpolate(frame, [20, 90], [0, 200], {
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
        }}
      >
        <FadeUp startFrame={10}>
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
            Core Feature 02
          </span>
        </FadeUp>

        <FadeUp startFrame={30} style={{ marginTop: 16, marginBottom: 24 }}>
          <span
            style={{
              fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
              fontSize: 52,
              fontWeight: 700,
              color: WHITE,
            }}
          >
            智能面板布局
          </span>
        </FadeUp>

        <div
          style={{
            width: lineWidth,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${CYAN}, transparent)`,
            marginBottom: 40,
          }}
        />

        <LayoutDiagram startFrame={90} />

        <FadeUp startFrame={220} style={{ marginTop: 32, display: "flex", gap: 24 }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 16,
              color: CYAN,
              padding: "10px 20px",
              border: "1px solid rgba(0,217,255,0.25)",
              borderRadius: 6,
              background: "rgba(0,217,255,0.06)",
            }}
          >
            <span style={{ opacity: 0.5 }}>$ </span>zvibe code
            <span
              style={{
                marginLeft: 12,
                fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
                fontSize: 13,
                color: DIM,
              }}
            >
              # 双 Agent 模式
            </span>
          </div>
        </FadeUp>

        <FadeUp startFrame={290} style={{ marginTop: 16 }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 16,
              color: "#A78BFA",
              padding: "10px 20px",
              border: "1px solid rgba(167,139,250,0.25)",
              borderRadius: 6,
              background: "rgba(167,139,250,0.06)",
            }}
          >
            <span style={{ opacity: 0.5 }}>$ </span>zvibe -t
            <span
              style={{
                marginLeft: 12,
                fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
                fontSize: 13,
                color: DIM,
              }}
            >
              # 右下角 Terminal
            </span>
          </div>
        </FadeUp>
      </AbsoluteFill>

      <div
        style={{
          position: "absolute",
          right: 64,
          bottom: 48,
          fontFamily: mono,
          fontSize: 100,
          fontWeight: 700,
          color: "rgba(0,217,255,0.04)",
          lineHeight: 1,
        }}
      >
        02
      </div>
    </AbsoluteFill>
  );
};

// ── Scene C: 后端 + Git 防呆 + 配置管理 ──────────────────────────────────

const CapabilityRow: React.FC<{
  index: string;
  title: string;
  desc: string;
  detail: string;
  color: string;
  startFrame: number;
}> = ({ index, title, desc, detail, color, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - startFrame, fps, config: { damping: 200 } });
  const x = interpolate(progress, [0, 1], [-40, 0]);

  return (
    <div
      style={{
        opacity: progress,
        transform: `translateX(${x}px)`,
        display: "flex",
        alignItems: "flex-start",
        gap: 24,
        padding: "20px 28px",
        borderRadius: 10,
        border: `1px solid ${color}25`,
        background: `${color}06`,
        width: "100%",
        maxWidth: 760,
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: 13,
          color: `${color}80`,
          letterSpacing: "2px",
          marginTop: 2,
          minWidth: 28,
        }}
      >
        {index}
      </span>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
            fontSize: 22,
            fontWeight: 700,
            color: WHITE,
            marginBottom: 6,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
            fontSize: 15,
            color: DIM,
            letterSpacing: "1px",
          }}
        >
          {desc}
        </div>
      </div>
      <div
        style={{
          fontFamily: mono,
          fontSize: 13,
          color,
          opacity: 0.75,
          padding: "4px 10px",
          border: `1px solid ${color}30`,
          borderRadius: 4,
          whiteSpace: "nowrap",
          alignSelf: "center",
        }}
      >
        {detail}
      </div>
    </div>
  );
};

export const FeatureExtras: React.FC = () => {
  const frame = useCurrentFrame();
  const lineWidth = interpolate(frame, [20, 90], [0, 200], {
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
        }}
      >
        <FadeUp startFrame={10}>
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
            Core Feature 03 – 05
          </span>
        </FadeUp>

        <FadeUp startFrame={30} style={{ marginTop: 16 }}>
          <span
            style={{
              fontFamily: `"PingFang SC", "Microsoft YaHei", sans-serif`,
              fontSize: 52,
              fontWeight: 700,
              color: WHITE,
            }}
          >
            更多核心能力
          </span>
        </FadeUp>

        <div
          style={{
            width: lineWidth,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${CYAN}, transparent)`,
            marginTop: 24,
            marginBottom: 40,
          }}
        />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            alignItems: "center",
          }}
        >
          <CapabilityRow
            index="03"
            title="后端策略"
            desc="Ghostty · Zellij · 自动降级，跨终端无缝切换"
            detail="--backend auto"
            color={CYAN}
            startFrame={90}
          />
          <CapabilityRow
            index="04"
            title="自动 Git 防呆"
            desc="在 HOME / 根目录自动跳过初始化，杜绝意外 git init"
            detail="autoGitInit"
            color="#34D399"
            startFrame={150}
          />
          <CapabilityRow
            index="05"
            title="配置管理 & 运维"
            desc="向导式配置 · 健康检查 · 一键更新 · JSON 结构化输出"
            detail="zvibe config"
            color="#A78BFA"
            startFrame={210}
          />
        </div>
      </AbsoluteFill>

      <div
        style={{
          position: "absolute",
          right: 64,
          bottom: 48,
          fontFamily: mono,
          fontSize: 100,
          fontWeight: 700,
          color: "rgba(0,217,255,0.04)",
          lineHeight: 1,
        }}
      >
        03
      </div>
    </AbsoluteFill>
  );
};
