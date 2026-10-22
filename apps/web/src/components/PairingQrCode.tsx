import { useMemo } from 'react';
import { encode } from 'uqr';

interface PairingQrCodeProps {
  value: string;
  label: string;
}

// Standard QR code (uqr, MIT). The quiet-zone border is part of the matrix so
// phone scanners can lock on without extra CSS padding.
export function PairingQrCode({ value, label }: PairingQrCodeProps) {
  const matrix = useMemo(() => encode(value, { ecc: 'M', border: 2 }), [value]);
  const size = matrix.size;
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="pebrel-qr-svg"
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      <rect width={size} height={size} fill="#FFFFFF" />
      {matrix.data.map((row, rIdx) =>
        row.map((cell, cIdx) =>
          cell ? <rect key={`${rIdx}-${cIdx}`} x={cIdx} y={rIdx} width={1} height={1} fill="#0F172A" /> : null,
        ),
      )}
    </svg>
  );
}
