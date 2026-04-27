export type ReviewStatusLabelValue = "NONE" | "NEEDS_REVIEW" | "RESOLVED";
export type UserRoleLabelValue = "ADMIN" | "EDITOR" | "REVIEWER" | "VIEWER";

export function reviewStatusLabel(status: ReviewStatusLabelValue | "" | null | undefined): string {
  if (status === "NEEDS_REVIEW") return "검토 필요";
  if (status === "RESOLVED") return "검토 완료";
  if (status === "NONE") return "정상";
  return "전체";
}

export function userRoleLabel(role: UserRoleLabelValue | null | undefined): string {
  if (role === "ADMIN") return "관리자";
  if (role === "EDITOR") return "편집자";
  if (role === "REVIEWER") return "검토자";
  if (role === "VIEWER") return "조회자";
  return "-";
}

export function sourceLabel(source: string): string {
  if (source === "manual") return "수동";
  if (source === "api") return "API";
  if (source === "wiki") return "위키";
  return source;
}
