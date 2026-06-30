import { AuthProvider, useAuth } from "./context/AuthContext";
import LoginPage from "./pages/LoginPage";
import BoardPage from "./pages/BoardPage";

function AppShell() {
  const { user } = useAuth();
  return user ? <BoardPage /> : <LoginPage />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}