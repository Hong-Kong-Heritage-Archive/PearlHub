import type { NextConfig } from "next";

module.exports = {
  allowedDevOrigins: ['192.168.1.247'],
}

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
