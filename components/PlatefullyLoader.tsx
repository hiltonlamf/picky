import { SproutIcon } from './icons';

type PlatefullyLoaderProps = {
  message?: string;
  overlay?: boolean;
};

function Plate() {
  return (
    <svg viewBox="0 0 72 72" className="platefully-loader-icon" aria-hidden="true">
      <ellipse cx="36" cy="39" rx="27" ry="14" fill="#fff" stroke="#12352a" strokeWidth="2.4" />
      <ellipse cx="36" cy="38" rx="18" ry="8" fill="#e4f5e7" stroke="#0b7a48" strokeWidth="1.8" />
      <path d="M17 43c5 8 33 10 39 0" fill="none" stroke="#12352a" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function Tofu() {
  return (
    <svg viewBox="0 0 72 72" className="platefully-loader-icon" aria-hidden="true">
      <path d="m15 27 23-11 20 10-23 12z" fill="#fffdf3" stroke="#12352a" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="m15 27 20 11v22L15 49z" fill="#f7eedf" stroke="#12352a" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="m35 38 23-12v22L35 60z" fill="#fff8e9" stroke="#12352a" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="42" cy="27" r="1.6" fill="#c8890b" />
      <circle cx="25" cy="29" r="1.4" fill="#c8890b" />
      <circle cx="48" cy="43" r="1.4" fill="#c8890b" />
    </svg>
  );
}

function Broccoli() {
  return (
    <svg viewBox="0 0 72 72" className="platefully-loader-icon" aria-hidden="true">
      <path d="M33 37c2 8 1 15-4 22h17c-5-8-6-15-2-23z" fill="#86dcab" stroke="#12352a" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M37 40c-3 7-3 13-2 19M42 38c-1 7 1 14 4 20" fill="none" stroke="#0b7a48" strokeWidth="2" strokeLinecap="round" />
      <circle cx="25" cy="30" r="10" fill="#0b7a48" stroke="#12352a" strokeWidth="2" />
      <circle cx="38" cy="23" r="12" fill="#00a35a" stroke="#12352a" strokeWidth="2" />
      <circle cx="50" cy="31" r="10" fill="#0b7a48" stroke="#12352a" strokeWidth="2" />
      <circle cx="37" cy="34" r="10" fill="#00c46a" stroke="#12352a" strokeWidth="2" />
    </svg>
  );
}

function Tomatoes() {
  return (
    <svg viewBox="0 0 72 72" className="platefully-loader-icon" aria-hidden="true">
      <circle cx="27" cy="41" r="15" fill="#ff5fae" stroke="#12352a" strokeWidth="2.2" />
      <circle cx="48" cy="38" r="12" fill="#ff2d8f" stroke="#12352a" strokeWidth="2.2" />
      <path d="m27 24 3 6 7-1-5 5 3 6-8-3-7 3 3-6-6-5 7 1z" fill="#0b7a48" stroke="#12352a" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="m48 24 2 5 6-1-4 4 2 5-6-3-5 3 2-5-4-4 5 1z" fill="#00a35a" stroke="#12352a" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

const pieces = [
  { key: 'plate-left', className: 'platefully-loader-piece--plate-left', illustration: <Plate /> },
  { key: 'tofu', className: 'platefully-loader-piece--tofu', illustration: <Tofu /> },
  { key: 'broccoli', className: 'platefully-loader-piece--broccoli', illustration: <Broccoli /> },
  { key: 'tomatoes', className: 'platefully-loader-piece--tomatoes', illustration: <Tomatoes /> },
  { key: 'plate-right', className: 'platefully-loader-piece--plate-right', illustration: <Plate /> },
];

export default function PlatefullyLoader({
  message = 'Plating up the next page…',
  overlay = false,
}: PlatefullyLoaderProps) {
  return (
    <div
      className={overlay ? 'platefully-loader platefully-loader--overlay' : 'platefully-loader platefully-loader--page'}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="platefully-loader-content">
        <div className="platefully-loader-pieces" aria-hidden="true">
          {pieces.map((piece) => (
            <div key={piece.key} className={`platefully-loader-piece ${piece.className}`}>
              {piece.illustration}
              <span className="platefully-loader-shadow" />
            </div>
          ))}
        </div>

        <div className="platefully-loader-brand" aria-hidden="true">
          <SproutIcon className="h-7 w-7 text-picky-600" />
          <span>Platefully</span>
        </div>
        <p className="platefully-loader-message">{message}</p>
      </div>
    </div>
  );
}
