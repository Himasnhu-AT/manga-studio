import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "./styles.css";
import { App } from "./App";
import { OnboardingWindow, isOnboardingWindow } from "./views/Onboarding";

// The desktop app opens first-run setup in its own small borderless window (label "onboarding").
const setupOnly = isOnboardingWindow();
if (setupOnly) document.documentElement.classList.add("setup-window");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* reducedMotion="user": every motion/react animation honors prefers-reduced-motion */}
    <MotionConfig reducedMotion="user">{setupOnly ? <OnboardingWindow /> : <App />}</MotionConfig>
  </StrictMode>,
);
