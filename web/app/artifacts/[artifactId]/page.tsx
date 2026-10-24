import ArtifactDetail from "../../../components/artifact-detail";

export default async function ArtifactDetailPage({ params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  return <ArtifactDetail artifactId={artifactId} />;
}
