import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { prefetchProviderStatus } from "./hooks/useProviderStatus.ts";

// Warm the LLM-provider availability probe before the first render so that
// opening the "new log" modal doesn't wait on the ~1s CLI-status check.
prefetchProviderStatus();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(<App />);
