import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";
import { StudyApp } from "../app/StudyApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode><StudyApp /></StrictMode>,
);
