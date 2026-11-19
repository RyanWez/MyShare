/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output lets the Docker image ship only the server it needs.
  output: "standalone",
};

export default nextConfig;
