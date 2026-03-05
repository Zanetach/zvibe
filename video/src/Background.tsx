import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const gridOpacity = interpolate(frame, [0, 1.5 * fps], [0, 0.055], {
    extrapolateRight: "clamp",
  });

  const glowOpacity = interpolate(frame, [0, 2 * fps], [0, 0.12], {
    extrapolateRight: "clamp",
  });

  const pulseScale = 1 + 0.015 * Math.sin((frame / fps) * Math.PI * 0.5);

  return (
    <AbsoluteFill style={{ background: "#070707" }}>
      {/* dot grid */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `radial-gradient(circle, rgba(0, 217, 255, ${gridOpacity}) 1px, transparent 1px)`,
          backgroundSize: "48px 48px",
        }}
      />
      {/* center radial glow */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          width: "900px",
          height: "900px",
          transform: `translate(-50%, -50%) scale(${pulseScale})`,
          background: `radial-gradient(circle, rgba(0, 180, 255, ${glowOpacity}) 0%, rgba(100, 60, 255, ${glowOpacity * 0.5}) 40%, transparent 70%)`,
          borderRadius: "50%",
          pointerEvents: "none",
        }}
      />
      {/* bottom ambient */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "220px",
          background:
            "linear-gradient(to top, rgba(0,217,255,0.035), transparent)",
        }}
      />
    </AbsoluteFill>
  );
};
