import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { openOnce } from "./demo/useOpening"
import "./index.css"

const root = document.getElementById("root")
if (!root) throw new Error("index.html lost its #root")

// The wallet and the Aztec SDK load with the first view that needs them: the recording reaches neither chain.
const openDemo = openOnce(() => import("./demo/start").then((m) => m.startDemo()))

createRoot(root).render(
	<StrictMode>
		<App openDemo={openDemo} />
	</StrictMode>,
)
