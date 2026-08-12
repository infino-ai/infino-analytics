import { useEffect, useState } from "react";
import ChatPage from "./ChatPage";
import DashboardsPage from "./DashboardsPage";
import { Logo } from "@/components/ui/logo";

// The app shell: header with the surface nav, and a tiny hash router — no
// routing dependency, nothing for a fork to untangle. Routes:
//   #/chat                 the conversational surface (default)
//   #/dashboards[/:id]     dashboards list / a rendered dashboard
function useRoute(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "") || "/chat";
}

const NAV = [
  { path: "/chat", label: "Fino" },
  { path: "/dashboards", label: "Dashboards" },
];

export default function App() {
  const route = useRoute();
  const section = NAV.find((n) => route === n.path || route.startsWith(`${n.path}/`))?.path ?? "/chat";

  const dashId = route.startsWith("/dashboards/") ? route.slice("/dashboards/".length) : undefined;

  return (
    <div className="app">
      <header className="header">
        <Logo className="h-[17px] w-auto self-center" />
        <span className="wordmark">Analytics</span>
        <nav className="nav">
          {NAV.map((n) => (
            <a className={section === n.path ? "navlink active" : "navlink"} href={`#${n.path}`} key={n.path}>
              {n.label}
            </a>
          ))}
        </nav>
      </header>
      {/* Chat stays mounted while other pages show, so navigating away
          doesn't drop an in-flight turn or the open thread. */}
      <div className={section === "/chat" ? "pagekeep show" : "pagekeep"}>
        <ChatPage />
      </div>
      {section === "/dashboards" && <DashboardsPage dashId={dashId} />}
    </div>
  );
}
