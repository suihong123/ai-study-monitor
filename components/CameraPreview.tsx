"use client";

import { forwardRef } from "react";

export const CameraPreview = forwardRef<HTMLVideoElement>(function CameraPreview(
  _props,
  ref
) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-black">
      <video
        ref={ref}
        className="aspect-[3/4] w-full object-cover sm:aspect-video"
        autoPlay
        muted
        playsInline
      />
    </div>
  );
});
