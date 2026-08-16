// Minimal hand-drawn line-icon set — 20x20, single currentColor stroke, no
// icon font/CDN dependency (keeps the "no build step" property intact).
// Each export returns a ready-to-inline <svg> string.

function svg(inner) {
  return `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export const iconDashboard = () =>
  svg(`<rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1"/><rect x="11" y="2.5" width="6.5" height="4" rx="1"/><rect x="11" y="8.5" width="6.5" height="9" rx="1"/><rect x="2.5" y="11" width="6.5" height="6.5" rx="1"/>`);

export const iconAdmin = () =>
  svg(`<path d="M10 2.5l6 2.2v4.6c0 4-2.6 6.9-6 8.2-3.4-1.3-6-4.2-6-8.2V4.7z"/><path d="M7.3 10l1.9 1.9 3.6-3.9"/>`);

export const iconResume = () =>
  svg(`<path d="M5 2.5h7l3 3V17a.5.5 0 0 1-.5.5H5.5A.5.5 0 0 1 5 17z"/><path d="M12 2.5V6h3.2"/><path d="M7 10h6M7 12.5h6M7 15h4"/>`);

export const iconAnswers = () =>
  svg(`<path d="M3 4.5h14v8.5H8.5L5 16v-3H3z"/><path d="M6.5 7.5h7M6.5 9.8h5"/>`);

export const iconCoverLetter = () =>
  svg(`<rect x="2.5" y="4" width="15" height="12" rx="1"/><path d="M3 5l7 5.5L17 5"/>`);

export const iconSettings = () =>
  svg(
    `<circle cx="10" cy="10" r="2.6"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M5.1 14.9l1.4-1.4M13.5 6.5l1.4-1.4"/>`
  );

export const iconUpload = () =>
  svg(`<path d="M10 13V4.5M6.8 7.3 10 4l3.2 3.3"/><path d="M4 13.5v1.8c0 .7.6 1.2 1.2 1.2h9.6c.7 0 1.2-.5 1.2-1.2v-1.8"/>`);

export const iconTrash = () =>
  svg(`<path d="M4.5 5.5h11M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6 5.5l.6 10a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-10"/>`);

export const iconPencil = () =>
  svg(`<path d="M12.5 3.5 16 7 6.5 16.5 3 17l.5-3.5z"/><path d="M11 5l3.5 3.5"/>`);

export const iconPlus = () => svg(`<path d="M10 4v12M4 10h12"/>`);

export const iconChevron = () => svg(`<path d="M5.5 7.5l4.5 5 4.5-5"/>`);

export const iconSun = () =>
  svg(
    `<circle cx="10" cy="10" r="3.2"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M4.6 15.4l1.4-1.4M14 6l1.4-1.4"/>`
  );

export const iconMoon = () => svg(`<path d="M15.5 12.2A6.5 6.5 0 0 1 7.8 4.5a6.5 6.5 0 1 0 7.7 7.7z"/>`);

export const iconWorkbenches = () =>
  svg(
    `<circle cx="7" cy="7" r="2.5"/><path d="M2.5 16v-1.2a3.5 3.5 0 0 1 3.5-3.5h2a3.5 3.5 0 0 1 3.5 3.5V16"/><circle cx="14.5" cy="7.5" r="2"/><path d="M12.8 11.3a3 3 0 0 1 4.7 2.5V16"/>`
  );

export const iconNotes = () =>
  svg(
    `<rect x="4" y="3" width="12.5" height="14" rx="1.5"/><path d="M4 5.5h2M4 8.5h2M4 11.5h2M4 14.5h1.5"/><path d="M8.5 6.5h6M8.5 9.5h6M8.5 12.5h4"/>`
  );

export const iconHelp = () =>
  svg(
    `<circle cx="10" cy="10" r="7.2"/><path d="M7.8 7.8a2.2 2.2 0 1 1 3.3 2.5c-.6.5-1.1.8-1.1 1.9"/><circle cx="10" cy="14" r="0.15" fill="currentColor" stroke-width="1.6"/>`
  );
