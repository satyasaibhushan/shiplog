import { createRoot } from "react-dom/client";
import { HostedDashboard } from "../../../src/hosted/dashboard";
import "../../../app/styles.css";
createRoot(document.getElementById("root")!).render(
  <main>
    <nav>
      <strong>Shiplog</strong>
      <span>Synthetic owner session</span>
    </nav>
    <HostedDashboard timezone="America/New_York" date="2026-11-01" />
  </main>,
);
