"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

export default class HostelAdminErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Hostel 面板必须与 Study 后台隔离；敏感上下文不写入浏览器日志。
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="rounded-md border border-line bg-white p-5">
          <h2 className="text-xl font-semibold">AI民宿 License 管理</h2>
          <p className="mt-3 text-sm text-alert">
            AI民宿只读面板暂时无法显示。AI学习监督后台未受影响，请切回后继续使用。
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}
