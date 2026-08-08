import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function Svg({ children, className = "h-5 w-5", strokeWidth = 1.8, ...rest }: P) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14M12 5v14" />
  </Svg>
);
export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);
export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const IconChevronUp = (p: P) => (
  <Svg {...p}>
    <path d="m18 15-6-6-6 6" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);
export const IconMic = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
  </Svg>
);
export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4Z" />
  </Svg>
);
export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v5h-5" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
    <path d="M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </Svg>
);
export const IconPin = (p: P) => (
  <Svg {...p}>
    <path d="M12 17v5" />
    <path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </Svg>
);
export const IconArchive = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="19" height="5" rx="1.5" />
    <path d="M4.5 8v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8M10 12.5h4" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5" />
  </Svg>
);
export const IconFlag = (p: P) => (
  <Svg {...p}>
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" />
    <path d="M4 22v-7" />
  </Svg>
);
export const IconRepeat = (p: P) => (
  <Svg {...p}>
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </Svg>
);
export const IconSliders = (p: P) => (
  <Svg {...p}>
    <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
  </Svg>
);
export const IconInbox = (p: P) => (
  <Svg {...p}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" />
  </Svg>
);
export const IconCalendar = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="17" rx="3" />
    <path d="M16 2.5v4M8 2.5v4M3 10h18" />
  </Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3a6.5 6.5 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Svg>
);
export const IconMonitor = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="3.5" width="19" height="13" rx="2.5" />
    <path d="M8.5 21h7M12 16.5V21" />
  </Svg>
);
export const IconChat = (p: P) => (
  <Svg {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-4.2-7.3" />
    <path d="M3.6 20.4 5 16.2" />
    <path d="M3.6 20.4 8 19" />
    <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
  </Svg>
);
export const IconNote = (p: P) => (
  <Svg {...p}>
    <path d="M15.5 3H5.5A2.5 2.5 0 0 0 3 5.5v13A2.5 2.5 0 0 0 5.5 21H14l7-7V5.5A2.5 2.5 0 0 0 18.5 3Z" />
    <path d="M14 21v-5a2 2 0 0 1 2-2h5" />
  </Svg>
);
export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M20 20a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.1a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 8.7 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
  </Svg>
);
export const IconChart = (p: P) => (
  <Svg {...p}>
    <path d="M3 3v16.5A1.5 1.5 0 0 0 4.5 21H21" />
    <path d="M7.5 16.5v-4M12 16.5v-8M16.5 16.5v-5.5" />
  </Svg>
);
export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" />
  </Svg>
);
export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M10.3 20.5a2 2 0 0 0 3.4 0" />
    <path d="M4 17c1.4-1.4 2-3 2-7a6 6 0 1 1 12 0c0 4 .6 5.6 2 7Z" />
  </Svg>
);
export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M21 15v3.5A2.5 2.5 0 0 1 18.5 21h-13A2.5 2.5 0 0 1 3 18.5V15" />
    <path d="m7.5 10.5 4.5 4.5 4.5-4.5M12 15V3" />
  </Svg>
);
export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M21 15v3.5A2.5 2.5 0 0 1 18.5 21h-13A2.5 2.5 0 0 1 3 18.5V15" />
    <path d="m7.5 7.5 4.5-4.5 4.5 4.5M12 3v12" />
  </Svg>
);
export const IconPencil = (p: P) => (
  <Svg {...p}>
    <path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L8 19l-4.5 1.5L5 16Z" />
    <path d="m15 6 3 3" />
  </Svg>
);
export const IconVolume = (p: P) => (
  <Svg {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
    <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18.5 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
);
export const IconSparkles = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l1.6 4.9L18.5 9.5l-4.9 1.6L12 16l-1.6-4.9L5.5 9.5l4.9-1.6z" />
    <path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.2l3.2 1.9" />
  </Svg>
);
export const IconTag = (p: P) => (
  <Svg {...p}>
    <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" />
    <circle cx="7.2" cy="7.2" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M9 21H5.5A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3H9" />
    <path d="m16 16 4-4-4-4M20 12H9" />
  </Svg>
);
export const IconKeyboard = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
    <path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M7.5 14h9" />
  </Svg>
);
export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M15 3h6v6M10.5 13.5 21 3" />
    <path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
  </Svg>
);
export const IconMenu = (p: P) => (
  <Svg {...p}>
    <path d="M4 6.5h16M4 12h16M4 17.5h16" />
  </Svg>
);
export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.4 1.4" />
    <path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.4-1.4" />
  </Svg>
);
export const IconList = (p: P) => (
  <Svg {...p}>
    <path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />
  </Svg>
);
export const IconWand = (p: P) => (
  <Svg {...p}>
    <path d="m3 21 12-12" />
    <path d="m14 4 1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
    <path d="m19 11 .7 1.4 1.4.7-1.4.7-.7 1.4-.7-1.4-1.4-.7 1.4-.7z" />
  </Svg>
);
