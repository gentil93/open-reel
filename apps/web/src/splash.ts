import { latent } from "@open-reel/darkroom";
import { createTranslator, matchLanguage } from "@open-reel/i18n";
import "./index.css";
import en from "./locales/en.json";
import ptBR from "./locales/pt-BR.json";

/**
 * What the desktop app shows while its server starts. The app navigates away
 * once the server is ready, or back here with `?failed=` if it stopped.
 */

const language = matchLanguage(
	navigator.languages ?? [],
	["en", "pt-BR"],
	"en",
);
const { t } = createTranslator(
	language,
	en,
	language === "pt-BR" ? ptBR : undefined,
);
document.documentElement.lang = language;

const status = document.getElementById("status") as HTMLElement;
const detail = document.getElementById("detail") as HTMLElement;
const frame = document.getElementById("frame") as HTMLCanvasElement;
status.textContent = t("desktop.starting");

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let running = !reduce;
latent(frame, undefined, performance.now());
const draw = (time: number) => {
	if (!running) return;
	latent(frame, undefined, time);
	requestAnimationFrame(draw);
};
if (running) requestAnimationFrame(draw);

const failed = new URLSearchParams(location.search).get("failed");
if (failed != null) {
	running = false;
	status.textContent = t("desktop.failed");
	status.classList.replace("text-dim", "text-danger");
	detail.textContent = failed;
	detail.classList.remove("hidden");
}
