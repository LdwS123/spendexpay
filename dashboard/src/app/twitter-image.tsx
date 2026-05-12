import { ImageResponse } from "next/og";

export const runtime = "edge";

export const alt = "Spendex Pay — The wallet for your AI agent";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function TwitterImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px 96px",
          background:
            "radial-gradient(circle at 80% 20%, rgba(0,229,180,0.18) 0%, rgba(0,229,180,0) 55%), radial-gradient(circle at 10% 90%, rgba(0,229,180,0.10) 0%, rgba(0,229,180,0) 50%), #070d18",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 20px",
              border: "1px solid rgba(0,229,180,0.25)",
              borderRadius: 9999,
              background: "rgba(0,229,180,0.08)",
              color: "#00e5b4",
              fontSize: 22,
              fontWeight: 600,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 9999,
                background: "#00e5b4",
              }}
            />
            @spendexai
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              display: "flex",
              fontSize: 110,
              fontWeight: 800,
              letterSpacing: -3,
              color: "#ffffff",
              lineHeight: 1,
            }}
          >
            Spendex&nbsp;
            <span style={{ color: "#00e5b4" }}>Pay</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 48,
              fontWeight: 500,
              color: "#00e5b4",
              letterSpacing: -1,
              lineHeight: 1.15,
            }}
          >
            The wallet for your AI agent.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              color: "rgba(255,255,255,0.55)",
              maxWidth: 920,
              lineHeight: 1.4,
            }}
          >
            Install once. Your agents sign up and pay for any service — within
            the rules you set.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 24,
            color: "rgba(255,255,255,0.45)",
            fontWeight: 500,
          }}
        >
          <span>spendexai.com</span>
          <span style={{ color: "#00e5b4" }}>→ install in 30s</span>
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
