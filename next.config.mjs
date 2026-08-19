/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/apps/hostel",
        destination: "https://hostel-ai-workspace.vercel.app",
        permanent: false
      },
      {
        source: "/apps/hostel/:path*",
        destination: "https://hostel-ai-workspace.vercel.app/:path*",
        permanent: false
      }
    ];
  }
};

export default nextConfig;
