import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("The Studio page has no #root");
createRoot(root).render(<App />);
