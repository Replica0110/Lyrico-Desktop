import { Button, Flex, Typography } from "antd";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportFrontendError } from "../backend/diagnostics";
import i18n from "../i18n";

const { Text } = Typography;

// The crash screen must render even when a page component has blown up. It reads the
// shared locale resources but never throws if they are unavailable.
function copy(key: "common.appError" | "common.reloadApp", fallback: string) {
  try {
    return i18n.t(key);
  } catch {
    return fallback;
  }
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportFrontendError("render", error, info.componentStack ?? "");
    console.error("AppErrorBoundary caught a render error", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Flex vertical align="center" justify="center" gap={12} style={{ minHeight: "100vh" }} role="alert">
        <Text>{copy("common.appError", "界面发生错误")}</Text>
        <Button onClick={() => window.location.reload()}>{copy("common.reloadApp", "重新加载应用")}</Button>
      </Flex>
    );
  }
}
