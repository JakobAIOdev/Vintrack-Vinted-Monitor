import { ImageResponse } from "next/og";

export const alt = "Vintrack Vinted monitoring dashboard";
export const size = {
    width: 1200,
    height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
    return new ImageResponse(
        <div
            style={{
                alignItems: "center",
                background: "#09090b",
                color: "#fafafa",
                display: "flex",
                height: "100%",
                justifyContent: "center",
                overflow: "hidden",
                position: "relative",
                width: "100%",
            }}
        >
            <div
                style={{
                    background:
                        "radial-gradient(circle at 15% 15%, rgba(16,185,129,0.26), transparent 30%), radial-gradient(circle at 85% 75%, rgba(59,130,246,0.2), transparent 34%)",
                    display: "flex",
                    inset: 0,
                    position: "absolute",
                }}
            />
            <div
                style={{
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 34,
                    display: "flex",
                    flexDirection: "column",
                    padding: "58px 64px",
                    position: "relative",
                    width: 1030,
                }}
            >
                <div
                    style={{
                        alignItems: "center",
                        display: "flex",
                        fontSize: 30,
                        fontWeight: 700,
                        gap: 18,
                    }}
                >
                    <div
                        style={{
                            alignItems: "center",
                            background: "#fafafa",
                            borderRadius: 12,
                            color: "#09090b",
                            display: "flex",
                            height: 54,
                            justifyContent: "center",
                            width: 54,
                        }}
                    >
                        V
                    </div>
                    Vintrack
                </div>
                <div
                    style={{
                        display: "flex",
                        fontSize: 64,
                        fontWeight: 750,
                        letterSpacing: "-2.5px",
                        lineHeight: 1.05,
                        marginTop: 54,
                        maxWidth: 870,
                    }}
                >
                    Open-source Vinted monitoring for faster finds.
                </div>
                <div
                    style={{
                        color: "#a1a1aa",
                        display: "flex",
                        fontSize: 25,
                        marginTop: 35,
                    }}
                >
                    Live dashboard · Discord & Telegram alerts · Self-hosted
                </div>
            </div>
        </div>,
        size,
    );
}
