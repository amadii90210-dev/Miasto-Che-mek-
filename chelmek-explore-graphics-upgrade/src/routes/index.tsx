import { createFileRoute } from "@tanstack/react-router";
import { ChelmekGame } from "@/components/ChelmekGame";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <ChelmekGame />;
}
