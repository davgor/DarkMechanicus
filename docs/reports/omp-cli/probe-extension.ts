// Throwaway probe extension for DM-406 (not shipped)
export default function (pi: any) {
	pi.on("session_start", async (_e: any, ctx: any) => {
		ctx.ui.setTitle("SKITARII-TITLE");
		ctx.ui.setStatus("probe", "STATUS-PROBE-TEXT");
		ctx.ui.setWorkingMessage("Communing with the Omnissiah");
		ctx.ui.setWidget("probe", ["WIDGET-LINE-1", "WIDGET-LINE-2"], { placement: "aboveEditor" });
		ctx.ui.setHeader(() => ({ render: () => ["HEADER-PROBE"], invalidate() {} }));
		ctx.ui.notify("EXT-LOADED notify", "info");
	});
}
