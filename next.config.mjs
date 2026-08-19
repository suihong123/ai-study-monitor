/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/apps/hostel",
        destination: "https://hostel.aistudyguard.top",
        permanent: false
      },
      {
        source: "/apps/hostel/:path*",
        destination: "https://hostel.aistudyguard.top/:path*",
        permanent: false
      }
    ];
  }
};

export default nextConfig;
