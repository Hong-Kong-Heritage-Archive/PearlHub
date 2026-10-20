import PublishedVersionView from "../../../../../components/published-version";

export default async function PublishedVersionPage({ params }: { params: Promise<{ artifactId: string; version: string }> }) {
  const { artifactId, version } = await params;
  return <PublishedVersionView artifactId={artifactId} version={version} />;
}
