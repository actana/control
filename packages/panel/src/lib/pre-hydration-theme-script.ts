import { THEME_CACHE_KEY } from "~/lib/use-theme";

/**
 * Pre-hydration script: runs synchronously in <head> (see __root.tsx) before
 * first paint so the theme class is in place before any CSS layout. One job:
 * read `mc:theme` (system/light/dark, default system — resolved via
 * prefers-color-scheme) and toggle the `.dark` class on <html>. Mirrors
 * `applyTheme` (src/lib/use-theme.ts); keep them in sync. Getting this wrong
 * causes a visible light/dark flash on cold start.
 */
export const PRE_HYDRATION_THEME_SCRIPT = `(function(){try{
var t=localStorage.getItem(${JSON.stringify(THEME_CACHE_KEY)});
var dark=t==="dark"||(t!=="light"&&typeof matchMedia==="function"&&matchMedia("(prefers-color-scheme: dark)").matches);
if(dark){document.documentElement.classList.add("dark");}
}catch(e){}})();`;
