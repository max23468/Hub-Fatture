export function DetailSectionHeader({
  description,
  icon,
  id,
  title,
}: {
  description: string;
  icon: React.ReactNode;
  id?: string;
  title: string;
}) {
  return (
    <header className="detail-section-header">
      <span className="dashboard-icon dashboard-icon--accent" aria-hidden="true">
        {icon}
      </span>
      <span>
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </span>
    </header>
  );
}
