import { AuthProvider, useAuth } from "./context/AuthContext";
import LoginPage from "./pages/LoginPage";
import BoardPage from "./pages/BoardPage";

function AppShell() {
  const { user, authLoading } = useAuth();
  if (authLoading) {
    return <div className="app-boot-loading">Restoring your session…</div>;
  }
  return user ? <BoardPage /> : <LoginPage />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}