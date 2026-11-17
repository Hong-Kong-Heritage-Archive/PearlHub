import type { NextConfig } from "next";

module.exports = {
  allowedDevOrigins: ['192.168.1.247'],
}

const nextConfig: NextConfig = {
  experimental: {
    agentUpgrade: "security",
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
