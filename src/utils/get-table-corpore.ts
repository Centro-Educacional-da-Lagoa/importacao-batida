export function getTotvsTableName(): string {
  const tableCorpore =
    process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'homolog'
      ? 'CORPORE_ERP'
      : 'CORPORE_ERP_MANUTENCAO';

  return `${tableCorpore}`;
}
