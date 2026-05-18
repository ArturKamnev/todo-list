export function LoadingSkeleton() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <div className="skeleton skeleton--wide" />
      <div className="skeleton" />
      <div className="skeleton skeleton--short" />
    </div>
  );
}
