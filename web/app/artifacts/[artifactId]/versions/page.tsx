import ArtifactVersions from "../../../../components/artifact-versions";

export default async function ArtifactVersionsPage({ params }: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await params;
  return <ArtifactVersions artifactId={artifactId} />;
}
