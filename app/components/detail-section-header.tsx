export function DetailSectionHeader({
  description,
  icon,
  title,
}: {
  description: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <header className="detail-section-header">
      <span className="dashboard-icon dashboard-icon--accent" aria-hidden="true">
        {icon}
      </span>
      <span>
        <h2>{title}</h2>
        <p>{description}</p>
      </span>
    </header>
  );
}
