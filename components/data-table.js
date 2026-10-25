export default function DataTable({ label, style, children }) {
  return (
    <div className="tableScroll" role="region" tabIndex={0} aria-label={label}>
      <table style={{ minWidth: 360, ...style }}>{children}</table>
    </div>
  );
}
